import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { zeroHash } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { MerkleDb } from "../src/merkledb/index.js";
import { namedAddress, parseSafe } from "./harness/utils.js";

const TWO_WEEKS = BigInt(60 * 60 * 24 * 7 * 2);
const REWARDS_UNTIL = BigInt(Date.UTC(2026, 9, 6) / 1000);
const MERKLE_ROOT = `0x${"42".repeat(32)}`;

const records = [] as string[];

const latestPath = (record: string) => path.join(record, "assets", "rewards", "latest.json");

/**
 * Creates a temporary record directory whose `latest.json` holds exactly `contents`, so that tests
 * control the raw on-disk format rather than going through `writeJsonFile`.
 */
const createRecord = async (contents: string): Promise<string> => {
	const record = await fs.mkdtemp(path.join(os.tmpdir(), "safenet-merkledb-"));
	records.push(record);
	await fs.mkdir(path.join(record, "assets", "rewards"), { recursive: true });
	await fs.writeFile(latestPath(record), contents, "utf8");
	return record;
};

const readLatest = async (record: string): Promise<Record<string, unknown>> =>
	JSON.parse(await fs.readFile(latestPath(record), "utf8"));

// A `latest.json` in the format of the currently pinned rewards DB: `jq --tab --sort-keys`
// output, with no `updatedAt`.
const PINNED_LATEST = `{
	"epoch": 0,
	"merkleRoot": "${MERKLE_ROOT}",
	"rewardsUntil": "2026-10-06T00:00:00.000Z",
	"tokenTotal": "${parseSafe("1000")}",
	"unpaidAmount": "${parseSafe("1.5")}"
}
`;

const nextPeriod = {
	fromTimestamp: REWARDS_UNTIL,
	toTimestamp: REWARDS_UNTIL + TWO_WEEKS,
};

afterEach(async () => {
	for (const record of records.splice(0)) {
		await fs.rm(record, { recursive: true, force: true });
	}
});

describe("merkledb index", () => {
	it("parses an index without `updatedAt`", async () => {
		const record = await createRecord(PINNED_LATEST);
		const index = await new MerkleDb({ record }).index();
		expect(index).toEqual({
			epoch: 0,
			merkleRoot: MERKLE_ROOT,
			tokenTotal: parseSafe("1000"),
			sentinelTokenTotal: 0n,
			unpaidAmount: parseSafe("1.5"),
			rewardsUntil: new Date("2026-10-06T00:00:00.000Z"),
		});
	});

	it("does not write `updatedAt` when distributing", async () => {
		const record = await createRecord(PINNED_LATEST);
		const db = new MerkleDb({ record });

		const update = await db.distribute(
			nextPeriod,
			{ [namedAddress("validator")]: { amount: parseSafe("300000"), sentinelAmount: 0n } },
			0n,
			{ sanctions: [] },
		);
		expect(update).not.toBeNull();

		const latest = await readLatest(record);
		expect(latest).not.toHaveProperty("updatedAt");
		expect(latest).toMatchObject({
			epoch: 0,
			rewardsUntil: "2026-10-20T00:00:00.000Z",
			tokenTotal: parseSafe("300000").toString(),
		});
	});

	it("does not write `updatedAt` when updating KYC", async () => {
		const record = await createRecord(PINNED_LATEST);
		const db = new MerkleDb({ record });
		const validator = namedAddress("validator");

		await db.distribute(
			nextPeriod,
			{ [validator]: { amount: parseSafe("300000"), sentinelAmount: 0n } },
			0n,
			{ sanctions: [] },
		);
		await db.kyc(nextPeriod, [validator], []);

		const latest = await readLatest(record);
		expect(latest).not.toHaveProperty("updatedAt");
		expect(latest).toMatchObject({ tokenTotal: parseSafe("300000").toString() });
	});

	it("rebuilds an empty tree when nothing is claimable", async () => {
		const record = await createRecord(PINNED_LATEST);
		const db = new MerkleDb({ record });
		const validator = namedAddress("validator");

		// The only payout is withheld pending KYC, so the tree has no leaves, but the withheld
		// amount is still funded and counted in the token total. The fixture's 1,000 SAFE total
		// has no entries behind it, so the rebuild replaces it.
		const update = await db.distribute(
			nextPeriod,
			{ [validator]: { amount: parseSafe("300000"), sentinelAmount: 0n } },
			0n,
			{ sanctions: [], kycThreshold: parseSafe("7500") },
		);
		expect(update).toEqual({ additionalAmount: parseSafe("299000"), merkleRoot: zeroHash });

		// A KYC update for an account with no entry creates one with nothing to claim, so the
		// tree stays empty.
		const kyc = await db.kyc(nextPeriod, [namedAddress("unknown")], []);
		expect(kyc).toEqual({ additionalAmount: 0n, merkleRoot: zeroHash });
		expect(await db.index()).toMatchObject({
			merkleRoot: zeroHash,
			tokenTotal: parseSafe("300000"),
		});
	});

	it("preserves the unpaid amount when updating KYC", async () => {
		const record = await createRecord(PINNED_LATEST);
		const db = new MerkleDb({ record });
		const validator = namedAddress("validator");

		await db.distribute(
			nextPeriod,
			{ [validator]: { amount: parseSafe("300000"), sentinelAmount: 0n } },
			parseSafe("2.5"),
			{ sanctions: [], kycThreshold: parseSafe("7500") },
		);
		await db.kyc(nextPeriod, [validator], []);

		// The KYC update releases the withheld payout without distributing anything, so the
		// unpaid amount from the period's distribution is kept.
		expect(await db.index()).toMatchObject({
			tokenTotal: parseSafe("300000"),
			unpaidAmount: parseSafe("2.5"),
		});
	});

	it("preserves the pinned unpaid amount when updating KYC", async () => {
		const record = await createRecord(PINNED_LATEST);
		const db = new MerkleDb({ record });

		// A KYC update right on top of the pinned index, with no paid entries at all.
		await db.kyc({ toTimestamp: REWARDS_UNTIL }, [namedAddress("validator")], []);
		expect(await db.index()).toMatchObject({
			merkleRoot: zeroHash,
			unpaidAmount: parseSafe("1.5"),
		});
	});
});
