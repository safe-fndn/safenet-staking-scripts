import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as CarBufferWriter from "@ipld/car/buffer-writer";
import * as dagPb from "@ipld/dag-pb";
import { importer } from "ipfs-unixfs-importer";
import type { CID } from "multiformats/cid";
import { toHex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { namedAddress, parseSafe } from "../../tests/harness/utils.js";
import { MerkleDb } from "../merkledb/index.js";
import { backoff } from "../utils/backoff.js";
import { AEGIS_REWARDS_START } from "../utils/sep.js";
import { packDirectory } from "./ipfs.js";
import {
	CAR_MEDIA_TYPE,
	type CarSource,
	DEFAULT_IPFS_GATEWAY_URL,
	fetchRewardsDb,
} from "./previous.js";

const TWO_WEEKS = BigInt(60 * 60 * 24 * 7 * 2);
const REWARDS_UNTIL = AEGIS_REWARDS_START + TWO_WEEKS;

// Retries each failed request twice, without waiting.
const fastBackoff = backoff({ delays: [0, 0] });

const temporaries: string[] = [];
const temporary = async (): Promise<string> => {
	const dir = await mkdtemp(join(tmpdir(), "safenet-previous-"));
	temporaries.push(dir);
	return dir;
};
afterEach(async () => {
	vi.unstubAllGlobals();
	await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

/**
 * A small rewards DB on top of a `latest.json` in the format of the pinned Beta rewards DB,
 * distributed once with `MerkleDb` for its `proofs/`, optionally with the files that the export
 * adds to a package.
 */
const rewardsDb = async ({ withPackageFiles = false } = {}) => {
	const dir = join(await temporary(), "rewards");
	const root = await temporary();
	await writeFile(
		join(root, "latest.json"),
		`{
	"epoch": 0,
	"merkleRoot": "${toHex(1, { size: 32 })}",
	"rewardsUntil": "2026-10-06T00:00:00.000Z",
	"tokenTotal": "0"
}
`,
	);
	const update = await new MerkleDb({ root }).distribute(
		{ fromTimestamp: AEGIS_REWARDS_START, toTimestamp: REWARDS_UNTIL },
		{
			[namedAddress("alice")]: { amount: parseSafe("1000"), sentinelAmount: 0n },
			[namedAddress("bob")]: { amount: parseSafe("2000"), sentinelAmount: parseSafe("500") },
		},
		0n,
		{ sanctions: [], kycApprovals: [] },
	);
	if (update === null) {
		throw new Error("fixture distribution was rejected");
	}
	if (withPackageFiles) {
		await writeFile(join(root, "manifest.json"), '{\n\t"version": 1\n}\n');
		await writeFile(join(root, "allocations.json"), "[]\n");
	}
	const { cid, car } = await packDirectory(root);
	return { cid, car, merkleRoot: update.merkleRoot, source: root, dir };
};

/** Stubs `fetch` with a handler, recording every request. */
const stubFetch = (handler: (url: string) => Response) => {
	const fetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) =>
		handler(String(input)),
	);
	vi.stubGlobal("fetch", fetch);
	return fetch;
};

const noFetch = () =>
	stubFetch((url) => {
		throw new Error(`unexpected fetch of ${url}`);
	});

/** Every directory (`null`) and file (its contents) under `dir`. */
const readTree = async (dir: string): Promise<Record<string, string | null>> => {
	const tree: Record<string, string | null> = {};
	for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
		const path = join(entry.parentPath, entry.name);
		tree[path.slice(dir.length + 1)] = entry.isDirectory() ? null : await readFile(path, "utf8");
	}
	return tree;
};

/** Packs a directory holding only the given files, for rewards DBs that fail to load. */
const packFiles = async (files: Record<string, string>) => {
	const root = await temporary();
	for (const [name, contents] of Object.entries(files)) {
		await writeFile(join(root, name), contents);
	}
	return { ...(await packDirectory(root)), dir: join(await temporary(), "rewards") };
};

const fetchDb = ({ cid }: { cid: CID }, dir: string, source: CarSource = {}, warn = vi.fn()) =>
	fetchRewardsDb(cid, source, dir, { withBackoff: fastBackoff, warn });

describe("fetchRewardsDb", () => {
	it("fetches a rewards DB from the default gateway", async () => {
		const db = await rewardsDb();
		const fetch = stubFetch(() => new Response(db.car));
		const warn = vi.fn();

		const fetched = await fetchDb(db, db.dir, {}, warn);

		expect(fetched).toEqual({
			cid: db.cid,
			merkleRoot: db.merkleRoot,
			rewardsUntil: REWARDS_UNTIL,
			dir: db.dir,
		});
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0]).toEqual([
			`http://127.0.0.1:8080/ipfs/${db.cid}?format=car`,
			{ headers: { Accept: "application/vnd.ipld.car; version=1" } },
		]);
		expect(await readTree(db.dir)).toEqual(await readTree(db.source));
		expect(warn).not.toHaveBeenCalled();
	});

	it("fetches from the configured gateway", async () => {
		const db = await rewardsDb();
		const fetch = stubFetch(() => new Response(db.car));

		await fetchDb(db, db.dir, { ipfsGatewayUrl: "https://gateway.example/" });

		expect(fetch.mock.calls[0]).toEqual([
			`https://gateway.example/ipfs/${db.cid}?format=car`,
			{ headers: { Accept: CAR_MEDIA_TYPE } },
		]);
		expect(DEFAULT_IPFS_GATEWAY_URL).toBe("http://127.0.0.1:8080");
	});

	it("fetches a rewards DB from a local CAR", async () => {
		const db = await rewardsDb();
		const previousCar = join(await temporary(), "previous.car");
		await writeFile(previousCar, db.car);
		const fetch = noFetch();

		const fetched = await fetchDb(db, db.dir, {
			previousCar,
			ipfsGatewayUrl: "https://gateway.example",
		});

		expect(fetched).toEqual({
			cid: db.cid,
			merkleRoot: db.merkleRoot,
			rewardsUntil: REWARDS_UNTIL,
			dir: db.dir,
		});
		expect(fetch).not.toHaveBeenCalled();
		expect(await readTree(db.dir)).toEqual(await readTree(db.source));
	});

	it("accepts a package with a manifest and allocations", async () => {
		const db = await rewardsDb({ withPackageFiles: true });
		stubFetch(() => new Response(db.car));
		const warn = vi.fn();

		const fetched = await fetchDb(db, db.dir, {}, warn);

		expect(fetched.cid).toEqual(db.cid);
		expect(fetched.rewardsUntil).toBe(REWARDS_UNTIL);
		expect((await readdir(db.dir)).sort()).toEqual([
			"allocations.json",
			"latest.json",
			"manifest.json",
			"proofs",
		]);
		expect(warn).not.toHaveBeenCalled();
	});

	it("retries gateway errors and then throws", async () => {
		const db = await rewardsDb();
		const fetch = stubFetch(() => new Response("nope", { status: 504, statusText: "Timeout" }));

		await expect(fetchDb(db, db.dir)).rejects.toThrow(
			`failed to fetch 'http://127.0.0.1:8080/ipfs/${db.cid}?format=car': 504 Timeout`,
		);
		expect(fetch).toHaveBeenCalledTimes(3);
		await expect(readdir(db.dir)).rejects.toThrow("ENOENT");
	});

	it("succeeds when the gateway recovers", async () => {
		const db = await rewardsDb();
		let attempts = 0;
		const fetch = stubFetch(() =>
			++attempts < 3 ? new Response(null, { status: 502 }) : new Response(db.car),
		);

		expect((await fetchDb(db, db.dir)).cid).toEqual(db.cid);
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it("rejects a CAR of a different CID", async () => {
		const expected = await rewardsDb();
		const other = await rewardsDb({ withPackageFiles: true });
		stubFetch(() => new Response(other.car));

		await expect(fetchDb(expected, expected.dir)).rejects.toThrow(
			`CAR roots ${other.cid} do not match expected ${expected.cid}`,
		);
		await expect(readdir(expected.dir)).rejects.toThrow("ENOENT");
	});

	it("refuses a rewards DB without latest.json", async () => {
		const packed = await packFiles({ "allocations.json": "[]\n" });
		stubFetch(() => new Response(packed.car));

		await expect(fetchDb(packed, packed.dir)).rejects.toThrow(
			`rewards DB ${packed.cid} has no latest.json`,
		);
	});

	it("refuses a rewards DB without rewardsUntil", async () => {
		const packed = await packFiles({
			"latest.json": `{"epoch":0,"merkleRoot":"${toHex(1, { size: 32 })}","tokenTotal":"0"}\n`,
		});
		stubFetch(() => new Response(packed.car));

		await expect(fetchDb(packed, packed.dir)).rejects.toThrow(
			`rewards DB ${packed.cid} has no rewardsUntil`,
		);
	});

	it("only warns when the unpacked rewards DB packs to a different CID", async () => {
		const db = await rewardsDb();
		// The same files, imported without raw leaves: a valid UnixFS DAG with another CID.
		const other = await importWithoutRawLeaves(db.source);
		expect(other.cid.equals(db.cid)).toBe(false);
		stubFetch(() => new Response(other.car));
		const warn = vi.fn();

		const fetched = await fetchDb(other, db.dir, {}, warn);

		expect(fetched.cid).toEqual(other.cid);
		expect(fetched.merkleRoot).toBe(db.merkleRoot);
		expect(await readTree(db.dir)).toEqual(await readTree(db.source));
		expect(warn).toHaveBeenCalledExactlyOnceWith(
			`rewards DB ${other.cid} packs to a different CID ${db.cid}`,
		);
	});
});

/**
 * Imports a directory with dag-pb file nodes instead of raw leaves, which `unpackCar` accepts but
 * `packDirectory` never produces.
 */
const importWithoutRawLeaves = async (dir: string): Promise<{ cid: CID; car: Uint8Array }> => {
	async function* candidates(
		path: string,
		prefix: string,
	): AsyncGenerator<{
		path: string;
		content?: Uint8Array;
	}> {
		yield { path: prefix };
		for (const entry of await readdir(path, { withFileTypes: true })) {
			const [child, childPrefix] = [join(path, entry.name), `${prefix}/${entry.name}`];
			if (entry.isDirectory()) {
				yield* candidates(child, childPrefix);
			} else {
				yield { path: childPrefix, content: await readFile(child) };
			}
		}
	}

	const blocks = new Map<string, { cid: CID; bytes: Uint8Array }>();
	const blockstore = {
		put: (cid: CID, bytes: Uint8Array) => {
			blocks.set(cid.toString(), { cid, bytes });
			return cid;
		},
	};
	let root: CID | undefined;
	for await (const entry of importer(candidates(dir, "root"), blockstore, {
		cidVersion: 1,
		rawLeaves: false,
		wrapWithDirectory: false,
	})) {
		if (entry.path === "root") {
			root = entry.cid;
		}
	}
	if (root === undefined) {
		throw new Error("no root CID");
	}

	// The importer also stores blocks that end up unreferenced, which `unpackCar` refuses, so only
	// the blocks reachable from the root are written.
	const reachable = new Map<string, { cid: CID; bytes: Uint8Array }>();
	const visit = (cid: CID) => {
		const block = blocks.get(cid.toString());
		if (block === undefined || reachable.has(cid.toString())) {
			return;
		}
		reachable.set(cid.toString(), block);
		if (cid.code === dagPb.code) {
			for (const link of dagPb.decode(block.bytes).Links) {
				visit(link.Hash);
			}
		}
	};
	visit(root);

	const roots = [root];
	const all = [...reachable.values()];
	const size =
		CarBufferWriter.headerLength({ roots }) +
		all.reduce((sum, block) => sum + CarBufferWriter.blockLength(block), 0);
	const writer = CarBufferWriter.createWriter(new ArrayBuffer(size), { roots });
	for (const block of all) {
		writer.write(block);
	}
	return { cid: root, car: writer.close() };
};
