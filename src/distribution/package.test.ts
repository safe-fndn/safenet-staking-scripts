import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { namedAddress, parseSafe } from "../../tests/harness/utils.js";
import { MerkleDb } from "../merkledb/index.js";
import { distributionPayouts } from "../safenet.js";
import { AEGIS_REWARDS_START } from "../utils/sep.js";
import { packDirectory, unpackCar } from "./ipfs.js";
import { kyc } from "./kyc.js";
import { copyRewardsDb } from "./package.js";

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

/** Distributes the first Aegis period into `dir`. */
const distribute = async (dir: string): Promise<void> => {
	const payouts = distributionPayouts({
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
	});
	const filters = { sanctions: [], kycThreshold: kyc().threshold, kycApprovals: kyc().accounts };
	const update = await new MerkleDb({ root: dir }).distribute(PERIOD, payouts, 1n, filters);
	if (update === null) {
		throw new Error("distribution was rejected");
	}
};

describe("copyRewardsDb", () => {
	it("copies a rewards DB byte for byte", async () => {
		const from = await pinnedRewardsDb();
		const dir = join(await temporary(), "work");
		await copyRewardsDb(from, dir);
		expect(await tree(dir)).toEqual(await tree(from));
		expect(Object.keys(await tree(dir)).sort()).toEqual(["latest.json", PINNED_PROOF]);
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
		expect(await readdir(dir)).toEqual(["file"]);
	});

	it("refuses anything outside the package layout", async () => {
		const cases: [string, (dir: string) => Promise<unknown>][] = [
			["no latest.json", (dir) => rm(join(dir, "latest.json"))],
			["manifest.json", (dir) => writeFile(join(dir, "manifest.json"), "{}\n")],
			["allocations.json", (dir) => writeFile(join(dir, "allocations.json"), "[]\n")],
			[".lock", (dir) => writeFile(join(dir, ".lock"), "")],
			["transactions", (dir) => mkdir(join(dir, "transactions"))],
			[
				"latest.json directory",
				async (dir) => {
					await rm(join(dir, "latest.json"));
					await mkdir(join(dir, "latest.json"));
				},
			],
			[
				"proofs file",
				(dir) =>
					rm(join(dir, "proofs"), { recursive: true }).then(() =>
						writeFile(join(dir, "proofs"), ""),
					),
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
			const parent = await temporary();
			const dir = join(parent, "work");
			await expect(copyRewardsDb(from, dir), name).rejects.toThrow();
			// The layout is checked before the target is created.
			expect(await readdir(parent), name).toEqual([]);
		}
	});

	it("round-trips a distributed rewards DB through IPFS", async () => {
		const dir = join(await temporary(), "package");
		await copyRewardsDb(await pinnedRewardsDb(), dir);
		await distribute(dir);

		const { cid, car } = await packDirectory(dir);
		const unpacked = join(await temporary(), "unpacked");
		await unpackCar(car, cid, unpacked);
		expect(await tree(unpacked)).toEqual(await tree(dir));

		// The unpacked package can be the previous rewards DB of the next one.
		const next = await temporary();
		await copyRewardsDb(unpacked, next);
		expect(await tree(next)).toEqual(await tree(dir));
	});
});
