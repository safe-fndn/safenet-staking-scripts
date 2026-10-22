import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MerkleDb } from "../src/merkledb/index.js";
import { type TimestampRange, timestampToDate } from "../src/utils/ranges.js";
import { AEGIS_REWARDS_START, BETA_REWARDS_UNTIL } from "../src/utils/sep.js";
import { namedAddress, parseSafe } from "./harness/utils.js";

const DAY = BigInt(60 * 60 * 24);
const WEEK = 7n * DAY;
const MERKLE_ROOT = `0x${"42".repeat(32)}`;

const records = [] as string[];

/**
 * Creates a temporary record directory whose `latest.json` has rewards distributed until
 * `rewardsUntil`, in the format of the currently pinned rewards DB.
 */
const createRecord = async (rewardsUntil: bigint): Promise<string> => {
	const record = await fs.mkdtemp(path.join(os.tmpdir(), "safenet-merkledb-"));
	records.push(record);
	await fs.mkdir(path.join(record, "assets", "rewards"), { recursive: true });
	await fs.writeFile(
		path.join(record, "assets", "rewards", "latest.json"),
		`{
	"epoch": 0,
	"merkleRoot": "${MERKLE_ROOT}",
	"rewardsUntil": "${timestampToDate(rewardsUntil).toISOString()}",
	"tokenTotal": "0",
	"unpaidAmount": "0"
}
`,
		"utf8",
	);
	return record;
};

const distribute = (db: MerkleDb, fromTimestamp: bigint, toTimestamp: bigint) =>
	db.distribute(
		{ fromTimestamp, toTimestamp } satisfies TimestampRange,
		{ [namedAddress("validator")]: { amount: parseSafe("1000"), sentinelAmount: 0n } },
		0n,
		{ sanctions: [] },
	);

afterEach(async () => {
	for (const record of records.splice(0)) {
		await fs.rm(record, { recursive: true, force: true });
	}
});

describe("merkledb beta to aegis gap", () => {
	it("accepts the first Aegis period after the last Beta period", async () => {
		const record = await createRecord(BETA_REWARDS_UNTIL);
		const db = new MerkleDb({ record });

		// No rewards are paid for the week between the end of Beta and the start of Aegis.
		const aegis = AEGIS_REWARDS_START;
		const update = await distribute(db, aegis, aegis + 2n * WEEK);
		expect(update).toMatchObject({ additionalAmount: parseSafe("1000") });
		expect(await db.index()).toMatchObject({
			rewardsUntil: timestampToDate(aegis + 2n * WEEK),
			tokenTotal: parseSafe("1000"),
		});

		// Periods after the gap are contiguous again.
		expect(await distribute(db, aegis + 3n * WEEK, aegis + 5n * WEEK)).toBeNull();
		expect(await distribute(db, aegis + 2n * WEEK, aegis + 4n * WEEK)).not.toBeNull();
		expect(await db.index()).toMatchObject({
			rewardsUntil: timestampToDate(aegis + 4n * WEEK),
			tokenTotal: parseSafe("2000"),
		});
	});

	it.each([
		["contiguous with the last Beta period", BETA_REWARDS_UNTIL, BETA_REWARDS_UNTIL + 2n * WEEK],
		["overlapping the last Beta period", BETA_REWARDS_UNTIL - DAY, AEGIS_REWARDS_START],
		["overlapping the gap", AEGIS_REWARDS_START - DAY, AEGIS_REWARDS_START + 2n * WEEK],
		["leaving a longer gap", AEGIS_REWARDS_START + WEEK, AEGIS_REWARDS_START + 3n * WEEK],
		["empty", AEGIS_REWARDS_START, AEGIS_REWARDS_START],
	])("rejects a period %s", async (_, from, to) => {
		const record = await createRecord(BETA_REWARDS_UNTIL);
		const db = new MerkleDb({ record });

		expect(await distribute(db, from, to)).toBeNull();
		expect(await db.index()).toMatchObject({
			rewardsUntil: timestampToDate(BETA_REWARDS_UNTIL),
			tokenTotal: 0n,
		});
	});

	it.each([
		["Beta", BETA_REWARDS_UNTIL - 2n * WEEK],
		["Aegis", AEGIS_REWARDS_START],
		["Aegis", AEGIS_REWARDS_START + 2n * WEEK],
	])("rejects a one week gap during %s", async (_, rewardsUntil) => {
		const record = await createRecord(rewardsUntil);
		const db = new MerkleDb({ record });

		expect(await distribute(db, rewardsUntil + WEEK, rewardsUntil + 3n * WEEK)).toBeNull();
		expect(await db.index()).toMatchObject({ tokenTotal: 0n });
	});
});
