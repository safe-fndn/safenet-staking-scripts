import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MANIFEST } from "../../tests/harness/manifest.js";
import { namedAddress, parseSafe } from "../../tests/harness/utils.js";
import { MerkleDb } from "../merkledb/index.js";
import { canonicalJson } from "../utils/json.js";
import { AEGIS_REWARDS_START } from "../utils/sep.js";
import { buildAllocations, zAllocations } from "./allocations.js";
import { packDirectory, unpackCar } from "./ipfs.js";
import { kyc } from "./kyc.js";
import { zManifest } from "./manifest.js";
import { ALLOCATIONS_FILE, copyRewardsDb, MANIFEST_FILE, writePackageFiles } from "./package.js";

// The pinned `latest.json` and one of its proofs, laid out as in the pinned rewards DB.
const FIXTURE = join(import.meta.dirname, "../../tests/fixtures/canonical");
const PINNED_ACCOUNT = "0x0484bf598554ab04b9b21421ed28bff6b7742993";
const PINNED_PROOF = join("proofs", "04", "84", "bf", "59", `${PINNED_ACCOUNT}.json`);

const TWO_WEEKS = BigInt(60 * 60 * 24 * 7 * 2);
const PERIOD = { fromTimestamp: AEGIS_REWARDS_START, toTimestamp: AEGIS_REWARDS_START + TWO_WEEKS };

const temporaries = [] as string[];
const temporary = async (): Promise<string> => {
	const dir = await mkdtemp(join(tmpdir(), "safenet-package-"));
	temporaries.push(dir);
	return dir;
};

afterEach(async () => {
	for (const dir of temporaries.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

/** Creates a rewards DB in the format of the one pinned at the end of Beta. */
const pinnedRewardsDb = async (): Promise<string> => {
	const dir = await temporary();
	await cp(join(FIXTURE, "latest.json"), join(dir, "latest.json"));
	await mkdir(join(dir, PINNED_PROOF, ".."), { recursive: true });
	await cp(join(FIXTURE, `${PINNED_ACCOUNT}.json`), join(dir, PINNED_PROOF));
	return dir;
};

/** Reads every file under `dir`, keyed by relative path. */
const tree = async (dir: string): Promise<Record<string, string>> => {
	const files = {} as Record<string, string>;
	for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
		if (entry.isFile()) {
			const path = join(entry.parentPath, entry.name);
			files[path.slice(dir.length + 1)] = await readFile(path, "utf8");
		}
	}
	return files;
};

/** Distributes the first Aegis period into `dir` and returns the package files for it. */
const distribute = async (dir: string) => {
	const payouts = {
		[namedAddress("validator")]: {
			stakeRewards: parseSafe("1000"),
			commission: parseSafe("50"),
			sentinelRewards: 0n,
		},
		[namedAddress("sentinel")]: {
			stakeRewards: 0n,
			commission: 0n,
			sentinelRewards: parseSafe("15000"),
		},
	};
	const filters = { sanctions: [], kycThreshold: kyc().threshold, kycApprovals: kyc().accounts };
	const flat = Object.fromEntries(
		Object.entries(payouts).map(([account, split]) => [
			account,
			{
				amount: split.stakeRewards + split.commission + split.sentinelRewards,
				sentinelAmount: split.sentinelRewards,
			},
		]),
	);
	const update = await new MerkleDb({ root: dir }).distribute(PERIOD, flat, 1n, filters);
	if (update === null) {
		throw new Error("distribution was rejected");
	}
	const { allocations, totals } = buildAllocations({ payouts, unpaid: 1n, forfeited: 0n }, filters);
	const manifest = {
		...MANIFEST,
		allocations: totals,
		distribution: { ...MANIFEST.distribution, merkleRoot: update.merkleRoot },
	};
	return { allocations, manifest };
};

describe("copyRewardsDb", () => {
	it("copies a rewards DB without a manifest byte for byte", async () => {
		const from = await pinnedRewardsDb();
		const dir = join(await temporary(), "work");
		await copyRewardsDb(from, dir);
		expect(await tree(dir)).toEqual(await tree(from));
		expect(Object.keys(await tree(dir)).sort()).toEqual(["latest.json", PINNED_PROOF]);
	});

	it("leaves out the previous manifest and allocations", async () => {
		const from = await pinnedRewardsDb();
		const expected = await tree(from);
		await writeFile(join(from, MANIFEST_FILE), "{}\n");
		await writeFile(join(from, ALLOCATIONS_FILE), "[]\n");

		const dir = await temporary();
		await copyRewardsDb(from, dir);
		expect(await tree(dir)).toEqual(expected);
	});

	it("copies a rewards DB with no proofs", async () => {
		const from = await temporary();
		await cp(join(FIXTURE, "latest.json"), join(from, "latest.json"));
		const dir = await temporary();
		await copyRewardsDb(from, dir);
		expect(await readdir(dir)).toEqual(["latest.json"]);
	});

	it("refuses a non-empty target", async () => {
		const from = await pinnedRewardsDb();
		const dir = await temporary();
		await writeFile(join(dir, "file"), "");
		await expect(copyRewardsDb(from, dir)).rejects.toThrow("is not empty");
	});

	it("refuses anything outside the package layout", async () => {
		const cases: [string, (dir: string) => Promise<unknown>][] = [
			["no latest.json", (dir) => rm(join(dir, "latest.json"))],
			[".lock", (dir) => writeFile(join(dir, ".lock"), "")],
			["transactions", (dir) => mkdir(join(dir, "transactions"))],
			[
				"latest.json directory",
				async (dir) => {
					await rm(join(dir, "latest.json"));
					await mkdir(join(dir, "latest.json"));
				},
			],
			["proofs/stray.json", (dir) => writeFile(join(dir, "proofs", "stray.json"), "")],
			["proofs/04/84/bf/59/x", (dir) => writeFile(join(dir, PINNED_PROOF, "..", "x"), "")],
			["proofs/04/84/bf/59/59", (dir) => mkdir(join(dir, PINNED_PROOF, "..", "59"))],
			["proofs/0A", (dir) => mkdir(join(dir, "proofs", "0A"))],
			[
				"misplaced proof",
				(dir) => writeFile(join(dir, PINNED_PROOF, "..", `0x0484bf58${"0".repeat(32)}.json`), ""),
			],
		];
		for (const [name, corrupt] of cases) {
			const from = await pinnedRewardsDb();
			await corrupt(from);
			const dir = await temporary();
			await expect(copyRewardsDb(from, dir), name).rejects.toThrow();
			expect(await readdir(dir), name).toEqual([]);
		}
	});
});

describe("writePackageFiles", () => {
	it("writes canonical package files that parse", async () => {
		const dir = await temporary();
		await copyRewardsDb(await pinnedRewardsDb(), dir);
		const files = await distribute(dir);
		await writePackageFiles(dir, files);

		const manifest = await readFile(join(dir, MANIFEST_FILE), "utf8");
		const allocations = await readFile(join(dir, ALLOCATIONS_FILE), "utf8");
		expect(manifest).toBe(canonicalJson(files.manifest));
		expect(allocations).toBe(canonicalJson(files.allocations));
		expect(zManifest.parse(JSON.parse(manifest))).toEqual(files.manifest);
		expect(zAllocations.parse(JSON.parse(allocations))).toEqual(files.allocations);
		expect((await readdir(dir)).sort()).toEqual([
			ALLOCATIONS_FILE,
			"latest.json",
			MANIFEST_FILE,
			"proofs",
		]);
	});

	it("refuses invalid files and unexpected contents without writing", async () => {
		type Files = Awaited<ReturnType<typeof distribute>>;
		const nothing = async () => {};
		const cases: [string, (dir: string) => Promise<unknown>, (files: Files) => Files][] = [
			["manifest.json", (dir) => writeFile(join(dir, MANIFEST_FILE), "{}\n"), (f) => f],
			[".lock", (dir) => writeFile(join(dir, ".lock"), ""), (f) => f],
			["transactions", (dir) => mkdir(join(dir, "transactions")), (f) => f],
			[
				"invalid manifest",
				nothing,
				(f) => ({ ...f, manifest: { ...f.manifest, version: 2 as 1 } }),
			],
			[
				"unsorted allocations",
				nothing,
				(f) => ({ ...f, allocations: [...f.allocations].reverse() }),
			],
		];
		for (const [name, corrupt, override] of cases) {
			const dir = await temporary();
			await copyRewardsDb(await pinnedRewardsDb(), dir);
			const files = await distribute(dir);
			await corrupt(dir);
			const before = await tree(dir);
			await expect(writePackageFiles(dir, override(files)), name).rejects.toThrow();
			expect(await tree(dir), name).toEqual(before);
		}
	});
});

describe("package assembly", () => {
	it("round-trips through IPFS", async () => {
		const previous = await pinnedRewardsDb();
		const dir = join(await temporary(), "package");
		await copyRewardsDb(previous, dir);
		await writePackageFiles(dir, await distribute(dir));

		const { cid, car } = await packDirectory(dir);
		const unpacked = join(await temporary(), "unpacked");
		await unpackCar(car, cid, unpacked);
		expect(await tree(unpacked)).toEqual(await tree(dir));

		// The unpacked package can be the previous rewards DB of the next one.
		const next = await temporary();
		await copyRewardsDb(unpacked, next);
		const files = await tree(dir);
		delete files[MANIFEST_FILE];
		delete files[ALLOCATIONS_FILE];
		expect(await tree(next)).toEqual(files);
	});
});
