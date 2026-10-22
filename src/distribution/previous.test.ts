import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as CarBufferWriter from "@ipld/car/buffer-writer";
import * as dagPb from "@ipld/dag-pb";
import { importer } from "ipfs-unixfs-importer";
import type { CID } from "multiformats/cid";
import {
	type Address,
	createClient,
	custom,
	decodeFunctionData,
	encodeFunctionResult,
	type Hex,
	namehash,
	toHex,
	zeroAddress,
} from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { namedAddress, parseSafe } from "../../tests/harness/utils.js";
import { CUMULATIVE_MERKLE_DROP_ABI, ENS_REGISTRY_ABI, ENS_RESOLVER_ABI } from "../abi.js";
import { MerkleDb } from "../merkledb/index.js";
import { backoff } from "../utils/backoff.js";
import { AEGIS_REWARDS_START } from "../utils/sep.js";
import { packDirectory } from "./ipfs.js";
import {
	CAR_MEDIA_TYPE,
	DEFAULT_IPFS_GATEWAY_URL,
	ENS_REGISTRY,
	fetchRewardsDb,
	resolvePreviousRewardsDb,
} from "./previous.js";
import { encodeContenthash } from "./transactions.js";

const ENS_NAME = "rewards.safenet-gov.eth";
const RESOLVER = namedAddress("resolver");
const DROP = namedAddress("drop");
const BLOCK_NUMBER = 1234n;
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

type Chain = {
	resolver?: Address;
	contenthash?: Hex;
	merkleRoot?: Hex;
};

/**
 * A fake mainnet that serves the ENS registry, the resolver of `ENS_NAME` and the Cumulative
 * Merkle Drop, recording the block tag of every call.
 */
const fakeChain = ({ resolver = RESOLVER, contenthash, merkleRoot }: Chain) => {
	const blockTags: string[] = [];
	const client = createClient({
		transport: custom({
			async request({ method, params }) {
				if (method === "eth_blockNumber") {
					return toHex(BLOCK_NUMBER);
				}
				if (method !== "eth_call") {
					throw new Error(`unsupported JSON-RPC method "${method}"`);
				}
				const [{ to, data }, blockTag] = params as [{ to: Address; data: Hex }, string];
				blockTags.push(blockTag);
				if (to.toLowerCase() === ENS_REGISTRY.toLowerCase()) {
					const { args } = decodeFunctionData({ abi: ENS_REGISTRY_ABI, data });
					expect(args).toEqual([namehash(ENS_NAME)]);
					return encodeFunctionResult({
						abi: ENS_REGISTRY_ABI,
						functionName: "resolver",
						result: resolver,
					});
				}
				if (to.toLowerCase() === RESOLVER.toLowerCase()) {
					const { functionName, args } = decodeFunctionData({ abi: ENS_RESOLVER_ABI, data });
					expect([functionName, args]).toEqual(["contenthash", [namehash(ENS_NAME)]]);
					return encodeFunctionResult({
						abi: ENS_RESOLVER_ABI,
						functionName: "contenthash",
						result: contenthash ?? "0x",
					});
				}
				if (to.toLowerCase() === DROP.toLowerCase()) {
					const { functionName } = decodeFunctionData({ abi: CUMULATIVE_MERKLE_DROP_ABI, data });
					expect(functionName).toBe("merkleRoot");
					return encodeFunctionResult({
						abi: CUMULATIVE_MERKLE_DROP_ABI,
						functionName: "merkleRoot",
						result: merkleRoot ?? toHex(0, { size: 32 }),
					});
				}
				throw new Error(`unexpected call to ${to}`);
			},
		}),
	});
	return { client, blockTags };
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

const resolve = (
	{ client }: ReturnType<typeof fakeChain>,
	dir: string,
	source: { previousCar?: string; ipfsGatewayUrl?: string } = {},
	warn = vi.fn(),
) =>
	resolvePreviousRewardsDb(client, { ensName: ENS_NAME, cumulativeMerkleDrop: DROP }, source, dir, {
		withBackoff: fastBackoff,
		warn,
	});

describe("resolvePreviousRewardsDb", () => {
	it("resolves the ENS-pinned rewards DB from the default gateway", async () => {
		const db = await rewardsDb();
		const chain = fakeChain({ contenthash: encodeContenthash(db.cid), merkleRoot: db.merkleRoot });
		const fetch = stubFetch(() => new Response(db.car));
		const warn = vi.fn();

		const previous = await resolve(chain, db.dir, {}, warn);

		expect(previous).toEqual({
			cid: db.cid,
			merkleRoot: db.merkleRoot,
			rewardsUntil: REWARDS_UNTIL,
			dir: db.dir,
			ensResolver: RESOLVER,
		});
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0]).toEqual([
			`http://127.0.0.1:8080/ipfs/${db.cid}?format=car`,
			{ headers: { Accept: "application/vnd.ipld.car; version=1" } },
		]);
		expect(await readTree(db.dir)).toEqual(await readTree(db.source));
		expect(warn).not.toHaveBeenCalled();
		// The ENS record and the drop's root are read at the same block.
		expect(chain.blockTags).toEqual(Array(3).fill(toHex(BLOCK_NUMBER)));
	});

	it("reads the chain at a given block", async () => {
		const db = await rewardsDb();
		const chain = fakeChain({ contenthash: encodeContenthash(db.cid), merkleRoot: db.merkleRoot });
		stubFetch(() => new Response(db.car));

		const previous = await resolvePreviousRewardsDb(
			chain.client,
			{ ensName: ENS_NAME, cumulativeMerkleDrop: DROP, blockNumber: 42n },
			{},
			db.dir,
			{ withBackoff: fastBackoff, warn: vi.fn() },
		);

		expect(previous.cid).toEqual(db.cid);
		expect(chain.blockTags).toEqual(Array(3).fill(toHex(42)));
	});

	it("fetches from the configured gateway", async () => {
		const db = await rewardsDb();
		const chain = fakeChain({ contenthash: encodeContenthash(db.cid), merkleRoot: db.merkleRoot });
		const fetch = stubFetch(() => new Response(db.car));

		await resolve(chain, db.dir, { ipfsGatewayUrl: "https://gateway.example/" });

		expect(fetch.mock.calls[0]).toEqual([
			`https://gateway.example/ipfs/${db.cid}?format=car`,
			{ headers: { Accept: CAR_MEDIA_TYPE } },
		]);
		expect(DEFAULT_IPFS_GATEWAY_URL).toBe("http://127.0.0.1:8080");
	});

	it("resolves the ENS-pinned rewards DB from a local CAR", async () => {
		const db = await rewardsDb();
		const chain = fakeChain({ contenthash: encodeContenthash(db.cid), merkleRoot: db.merkleRoot });
		const previousCar = join(await temporary(), "previous.car");
		await writeFile(previousCar, db.car);
		const fetch = noFetch();

		const previous = await resolve(chain, db.dir, {
			previousCar,
			ipfsGatewayUrl: "https://gateway.example",
		});

		expect(previous).toEqual({
			cid: db.cid,
			merkleRoot: db.merkleRoot,
			rewardsUntil: REWARDS_UNTIL,
			dir: db.dir,
			ensResolver: RESOLVER,
		});
		expect(fetch).not.toHaveBeenCalled();
		expect(await readTree(db.dir)).toEqual(await readTree(db.source));
	});

	it("accepts a package with a manifest and allocations", async () => {
		const db = await rewardsDb({ withPackageFiles: true });
		const chain = fakeChain({ contenthash: encodeContenthash(db.cid), merkleRoot: db.merkleRoot });
		stubFetch(() => new Response(db.car));
		const warn = vi.fn();

		const previous = await resolve(chain, db.dir, {}, warn);

		expect(previous.cid).toEqual(db.cid);
		expect(previous.rewardsUntil).toBe(REWARDS_UNTIL);
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
		const chain = fakeChain({ contenthash: encodeContenthash(db.cid), merkleRoot: db.merkleRoot });
		const fetch = stubFetch(() => new Response("nope", { status: 504, statusText: "Timeout" }));

		await expect(resolve(chain, db.dir)).rejects.toThrow(
			`failed to fetch 'http://127.0.0.1:8080/ipfs/${db.cid}?format=car': 504 Timeout`,
		);
		expect(fetch).toHaveBeenCalledTimes(3);
		await expect(readdir(db.dir)).rejects.toThrow("ENOENT");
	});

	it("succeeds when the gateway recovers", async () => {
		const db = await rewardsDb();
		const chain = fakeChain({ contenthash: encodeContenthash(db.cid), merkleRoot: db.merkleRoot });
		let attempts = 0;
		const fetch = stubFetch(() =>
			++attempts < 3 ? new Response(null, { status: 502 }) : new Response(db.car),
		);

		expect((await resolve(chain, db.dir)).cid).toEqual(db.cid);
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it("refuses a name without a resolver", async () => {
		const chain = fakeChain({ resolver: zeroAddress });
		const fetch = noFetch();
		await expect(resolve(chain, await temporary())).rejects.toThrow(
			`ENS name ${ENS_NAME} has no resolver`,
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("refuses a name without a contenthash", async () => {
		const chain = fakeChain({ contenthash: "0x" });
		noFetch();
		await expect(resolve(chain, await temporary())).rejects.toThrow(
			`ENS name ${ENS_NAME} has no contenthash`,
		);
	});

	it("refuses a contenthash that is not IPFS", async () => {
		// A Swarm (`swarm-ns`) contenthash.
		const contenthash = `0xe40101fa011b20${"ab".repeat(32)}` as Hex;
		const chain = fakeChain({ contenthash });
		noFetch();
		await expect(resolve(chain, await temporary())).rejects.toThrow(
			`contenthash ${contenthash} is not an IPFS contenthash`,
		);
	});

	it("rejects a CAR of a different CID", async () => {
		const pinned = await rewardsDb();
		const other = await rewardsDb({ withPackageFiles: true });
		const chain = fakeChain({
			contenthash: encodeContenthash(pinned.cid),
			merkleRoot: pinned.merkleRoot,
		});
		stubFetch(() => new Response(other.car));

		await expect(resolve(chain, pinned.dir)).rejects.toThrow(
			`CAR roots ${other.cid} do not match expected ${pinned.cid}`,
		);
		await expect(readdir(pinned.dir)).rejects.toThrow("ENOENT");
	});

	it("refuses a Merkle root that differs from the drop's", async () => {
		const db = await rewardsDb();
		const onchain = toHex(0x42, { size: 32 });
		const chain = fakeChain({ contenthash: encodeContenthash(db.cid), merkleRoot: onchain });
		stubFetch(() => new Response(db.car));

		await expect(resolve(chain, db.dir)).rejects.toThrow(
			`rewards DB ${db.cid} pinned by ${ENS_NAME} has Merkle root ${db.merkleRoot}, ` +
				`but CumulativeMerkleDrop ${DROP} has Merkle root ${onchain}`,
		);
	});

	it("only warns when the unpacked rewards DB packs to a different CID", async () => {
		const db = await rewardsDb();
		// The same files, imported without raw leaves: a valid UnixFS DAG with another CID.
		const other = await importWithoutRawLeaves(db.source);
		expect(other.cid.equals(db.cid)).toBe(false);
		const chain = fakeChain({
			contenthash: encodeContenthash(other.cid),
			merkleRoot: db.merkleRoot,
		});
		stubFetch(() => new Response(other.car));
		const warn = vi.fn();

		const previous = await resolve(chain, db.dir, {}, warn);

		expect(previous.cid).toEqual(other.cid);
		expect(previous.merkleRoot).toBe(db.merkleRoot);
		expect(await readTree(db.dir)).toEqual(await readTree(db.source));
		expect(warn).toHaveBeenCalledExactlyOnceWith(
			`rewards DB ${other.cid} packs to a different CID ${db.cid}`,
		);
	});
});

describe("fetchRewardsDb", () => {
	it("fetches a rewards DB by CID without reading the chain", async () => {
		const db = await rewardsDb({ withPackageFiles: true });
		stubFetch(() => new Response(db.car));

		expect(
			await fetchRewardsDb(db.cid, {}, db.dir, { withBackoff: fastBackoff, warn: vi.fn() }),
		).toEqual({
			cid: db.cid,
			merkleRoot: db.merkleRoot,
			rewardsUntil: REWARDS_UNTIL,
			dir: db.dir,
		});
	});

	it("refuses a rewards DB without latest.json", async () => {
		const packed = await packFiles({ "allocations.json": "[]\n" });
		stubFetch(() => new Response(packed.car));

		await expect(
			fetchRewardsDb(packed.cid, {}, packed.dir, { withBackoff: fastBackoff, warn: vi.fn() }),
		).rejects.toThrow(`rewards DB ${packed.cid} has no latest.json`);
	});

	it("refuses a rewards DB without rewardsUntil", async () => {
		const packed = await packFiles({
			"latest.json": `{"epoch":0,"merkleRoot":"${toHex(1, { size: 32 })}","tokenTotal":"0"}\n`,
		});
		stubFetch(() => new Response(packed.car));

		await expect(
			fetchRewardsDb(packed.cid, {}, packed.dir, { withBackoff: fastBackoff, warn: vi.fn() }),
		).rejects.toThrow(`rewards DB ${packed.cid} has no rewardsUntil`);
	});
});

/** Packs a directory holding only the given files, for rewards DBs that fail to load. */
const packFiles = async (files: Record<string, string>) => {
	const root = await temporary();
	for (const [name, contents] of Object.entries(files)) {
		await writeFile(join(root, name), contents);
	}
	return { ...(await packDirectory(root)), dir: join(await temporary(), "rewards") };
};

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
