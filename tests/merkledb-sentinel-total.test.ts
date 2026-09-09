import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { zeroHash } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { MerkleDb } from "../src/merkledb/index.js";
import { totalRewardsAmount } from "../src/utils/args.js";
import { writeJsonFile } from "../src/utils/json.js";
import { namedAddress, parseSafe } from "./harness/utils.js";

const TWO_WEEKS = BigInt(60 * 60 * 24 * 7 * 2);
const REWARDS_START = BigInt(Date.UTC(2026, 3, 7) / 1000);

// The `n`-th two week rewards period of the program, counting from zero.
const period = (n: number) => ({
	fromTimestamp: REWARDS_START + BigInt(n) * TWO_WEEKS,
	toTimestamp: REWARDS_START + BigInt(n + 1) * TWO_WEEKS,
});

const records = [] as string[];

/**
 * Creates a temporary record directory holding a `latest.json` that has nothing distributed yet
 * and is caught up to the very start of the rewards program.
 */
const createRecord = async (index?: Record<string, unknown>): Promise<string> => {
	const record = await fs.mkdtemp(path.join(os.tmpdir(), "safenet-merkledb-"));
	records.push(record);
	await fs.mkdir(path.join(record, "assets", "rewards"), { recursive: true });
	await writeJsonFile(path.join(record, "assets", "rewards", "latest.json"), {
		merkleRoot: zeroHash,
		tokenTotal: 0n,
		updatedAt: new Date(0),
		rewardsUntil: new Date(Number(REWARDS_START) * 1000),
		...index,
	});
	return record;
};

/**
 * Reads the raw distribution entry written for `account`, as it lands on disk.
 */
const readEntry = async (record: string, account: string): Promise<Record<string, unknown>> => {
	const pattern = path.join(
		record,
		"assets",
		"rewards",
		"proofs",
		"**",
		`${account.toLowerCase()}.json`,
	);
	for await (const entry of fs.glob(pattern)) {
		return JSON.parse(await fs.readFile(entry, "utf8"));
	}
	throw new Error(`no distribution entry for ${account}`);
};

const budget = (record: string, n: number) => {
	const { fromTimestamp, toTimestamp } = period(n);
	return totalRewardsAmount({
		rewardPeriodStart: fromTimestamp,
		rewardPeriodEnd: toTimestamp,
		record,
	});
};

afterEach(async () => {
	for (const record of records.splice(0)) {
		await fs.rm(record, { recursive: true, force: true });
	}
});

describe("merkledb sentinel total", () => {
	it("defaults the sentinel total for records written before sentinel rewards", async () => {
		const record = await createRecord({ tokenTotal: parseSafe("1000") });
		const index = await new MerkleDb({ record }).index();
		expect(index).toMatchObject({
			tokenTotal: parseSafe("1000"),
			sentinelTokenTotal: 0n,
		});
	});

	it("leaves the validator budget unaffected by sentinel spend", async () => {
		const validator = namedAddress("validator");
		const sentinel = namedAddress("sentinel");

		// Both records distribute the exact same validator payouts; the mixed one additionally
		// pays a sentinel out of the same distribution.
		const validatorPayout = parseSafe("300000");
		const sentinelPayout = parseSafe("15000");

		const baselineRecord = await createRecord();
		const baseline = new MerkleDb({ record: baselineRecord });
		const mixedRecord = await createRecord();
		const mixed = new MerkleDb({ record: mixedRecord });

		for (const n of [0, 1]) {
			const baselineUpdate = await baseline.distribute(
				period(n),
				{ [validator]: { amount: validatorPayout, sentinelAmount: 0n } },
				0n,
				{ sanctions: [] },
			);
			const mixedUpdate = await mixed.distribute(
				period(n),
				{
					[validator]: { amount: validatorPayout, sentinelAmount: 0n },
					[sentinel]: { amount: sentinelPayout, sentinelAmount: sentinelPayout },
				},
				0n,
				{ sanctions: [] },
			);

			// The transfer to the cumulative Merkle drop funds both programs, so it *is* larger.
			expect(baselineUpdate?.additionalAmount).toBe(validatorPayout);
			expect(mixedUpdate?.additionalAmount).toBe(validatorPayout + sentinelPayout);
		}

		// After two periods, the mixed record has distributed 30,000 SAFE more in total, all of
		// it sentinel spend.
		expect(await baseline.index()).toMatchObject({
			tokenTotal: 2n * validatorPayout,
			sentinelTokenTotal: 0n,
		});
		expect(await mixed.index()).toMatchObject({
			tokenTotal: 2n * (validatorPayout + sentinelPayout),
			sentinelTokenTotal: 2n * sentinelPayout,
		});

		// 4.5M SAFE over 26 weeks, so 6 of those weeks are worth
		// 1,038,461.538461538461538461 SAFE, of which 600,000 SAFE has already been paid out to
		// validators over the two periods above. The 30,000 SAFE of sentinel spend does not
		// reduce the budget.
		expect(await budget(baselineRecord, 2)).toBe(parseSafe("438461.538461538461538461"));
		expect(await budget(mixedRecord, 2)).toBe(await budget(baselineRecord, 2));
	});

	it("splits a merged validator and sentinel payout within one entry", async () => {
		// A sentinel that also runs a validator claims both programs from a single entry, so the
		// sentinel share has to be tracked per entry rather than inferred from the payout.
		const both = namedAddress("validator-and-sentinel");
		const record = await createRecord();
		const db = new MerkleDb({ record });

		for (const n of [0, 1]) {
			await db.distribute(
				period(n),
				{ [both]: { amount: parseSafe("40000"), sentinelAmount: parseSafe("15000") } },
				0n,
				{ sanctions: [] },
			);
		}

		expect(await readEntry(record, both)).toMatchObject({
			cumulativeAmount: parseSafe("80000").toString(),
			sentinelAmount: parseSafe("30000").toString(),
		});
		expect(await db.index()).toMatchObject({
			tokenTotal: parseSafe("80000"),
			sentinelTokenTotal: parseSafe("30000"),
		});
	});

	it("recomputes the sentinel total from the distribution entries", async () => {
		// The total is derived, not accumulated: an entry edited on disk is picked up by the
		// next rebuild, exactly as `tokenTotal` is.
		const sentinel = namedAddress("sentinel");
		const record = await createRecord();
		const db = new MerkleDb({ record });

		await db.distribute(
			period(0),
			{ [sentinel]: { amount: parseSafe("15000"), sentinelAmount: parseSafe("15000") } },
			0n,
			{ sanctions: [] },
		);
		expect(await db.index()).toMatchObject({ sentinelTokenTotal: parseSafe("15000") });

		// A rebuild that distributes nothing to the sentinel leaves its total where it was.
		await db.distribute(
			period(1),
			{ [namedAddress("validator")]: { amount: parseSafe("300000"), sentinelAmount: 0n } },
			0n,
			{ sanctions: [] },
		);
		expect(await db.index()).toMatchObject({
			tokenTotal: parseSafe("315000"),
			sentinelTokenTotal: parseSafe("15000"),
		});
	});

	it("preserves the sentinel total across a KYC rebuild", async () => {
		const record = await createRecord();
		const db = new MerkleDb({ record });
		const sentinel = namedAddress("sentinel");
		const sentinelPayout = parseSafe("15000");

		// A KYC update rebuilds the tree without distributing anything, so it must leave the
		// accumulated sentinel total alone.
		const update = await db.distribute(
			period(0),
			{ [sentinel]: { amount: sentinelPayout, sentinelAmount: sentinelPayout } },
			0n,
			{ sanctions: [] },
		);
		expect(update).not.toBeNull();

		await db.kyc(period(0), [sentinel], []);
		expect(await db.index()).toMatchObject({
			tokenTotal: sentinelPayout,
			sentinelTokenTotal: sentinelPayout,
		});
	});
});
