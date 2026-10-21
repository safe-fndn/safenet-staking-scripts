import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sentinelRewardsAmount, totalRewardsAmount } from "./args.js";
import {
	AEGIS_REWARDS_START,
	AEGIS_VALIDATOR_REWARDS,
	BETA_REWARDS_UNTIL,
	BETA_TOKEN_TOTAL,
} from "./sep.js";

const WEEK = 60n * 60n * 24n * 7n;

const records = [] as string[];

/**
 * Creates a temporary record directory whose `latest.json` holds exactly `contents`.
 */
const createRecord = async (contents: string): Promise<string> => {
	const record = await fs.mkdtemp(path.join(os.tmpdir(), "safenet-args-"));
	records.push(record);
	await fs.mkdir(path.join(record, "assets", "rewards"), { recursive: true });
	await fs.writeFile(path.join(record, "assets", "rewards", "latest.json"), contents, "utf8");
	return record;
};

/**
 * Creates a temporary record directory with a `latest.json` written by this tooling.
 */
const createAegisRecord = (index: {
	rewardsUntil: bigint;
	tokenTotal: bigint;
	sentinelTokenTotal: bigint;
}): Promise<string> =>
	createRecord(`{
	"epoch": 0,
	"merkleRoot": "0x${"42".repeat(32)}",
	"rewardsUntil": "${new Date(Number(index.rewardsUntil) * 1000).toISOString()}",
	"sentinelTokenTotal": "${index.sentinelTokenTotal}",
	"tokenTotal": "${index.tokenTotal}",
	"unpaidAmount": "0"
}
`);

afterEach(async () => {
	for (const record of records.splice(0)) {
		await fs.rm(record, { recursive: true, force: true });
	}
});

describe("totalRewardsAmount", () => {
	it("uses the overridden total rewards amount", async () => {
		expect(await totalRewardsAmount({ totalRewards: 42n })).toBe(42n);
	});

	it("computes the per-period amount for a default two-week period", async () => {
		// 5,000,000 SAFE over 52 weeks, i.e. 2/52 of that for a two week period.
		expect(await totalRewardsAmount({})).toBe(192307692307692307692307n);
	});

	it("prorates by the actual period duration", async () => {
		expect(
			await totalRewardsAmount({
				rewardPeriodStart: AEGIS_REWARDS_START,
				rewardPeriodEnd: AEGIS_REWARDS_START + WEEK,
			}),
		).toBe(96153846153846153846153n);
	});

	it("pays the full first Aegis period on top of the pinned Beta rewards DB", async () => {
		// The `latest.json` of the rewards DB pinned at the end of Beta. Its leftover unpaid
		// amount is not carried forward into Aegis.
		const record = await createRecord(`{
	"epoch": 0,
	"merkleRoot": "0x668901980a6c69b801f37cdef375059369dab712db8651a463d1d336b65cfdef",
	"rewardsUntil": "${new Date(Number(BETA_REWARDS_UNTIL) * 1000).toISOString()}",
	"tokenTotal": "${BETA_TOKEN_TOTAL}",
	"unpaidAmount": "12225192329728798030"
}
`);
		expect(
			await totalRewardsAmount({
				rewardPeriodStart: AEGIS_REWARDS_START,
				rewardPeriodEnd: AEGIS_REWARDS_START + 2n * WEEK,
				record,
			}),
		).toBe(192307692307692307692307n);
	});

	it("refuses a record that is not caught up to the end of Beta", async () => {
		const empty = await fs.mkdtemp(path.join(os.tmpdir(), "safenet-args-"));
		records.push(empty);
		const beta = await createAegisRecord({
			rewardsUntil: BETA_REWARDS_UNTIL - 2n * WEEK,
			tokenTotal: 0n,
			sentinelTokenTotal: 0n,
		});
		for (const record of [empty, beta]) {
			await expect(
				totalRewardsAmount({
					rewardPeriodStart: AEGIS_REWARDS_START,
					rewardPeriodEnd: AEGIS_REWARDS_START + 2n * WEEK,
					record,
				}),
			).rejects.toThrow("record is not caught up to the end of Beta");
		}
	});

	it("accounts for past Aegis distributions when --record is set", async () => {
		// Two Aegis periods of 192,307.69… SAFE each, with 5 wei of validator rewards left
		// unpaid and 30,000 SAFE of sentinel rewards on top. The third period catches up to
		// 6/52 of the budget: 576,923,076923076923076923 - 384,615,384615384615384609 wei.
		const sentinelTokenTotal = 30000n * 10n ** 18n;
		const record = await createAegisRecord({
			rewardsUntil: AEGIS_REWARDS_START + 4n * WEEK,
			tokenTotal: BETA_TOKEN_TOTAL + 384615384615384615384609n + sentinelTokenTotal,
			sentinelTokenTotal,
		});
		expect(
			await totalRewardsAmount({
				rewardPeriodStart: AEGIS_REWARDS_START + 4n * WEEK,
				rewardPeriodEnd: AEGIS_REWARDS_START + 6n * WEEK,
				record,
			}),
		).toBe(192307692307692307692314n);
	});

	it("distributes exactly the Aegis budget by the end of the 52 weeks", async () => {
		// After 50 weeks with 7 wei left unpaid, the last period pays out the rest of the
		// 5,000,000 SAFE: 5,000,000 SAFE - (4,807,692,307692307692307692 - 7) wei.
		const paid = 4807692307692307692307692n - 7n;
		const last = await createAegisRecord({
			rewardsUntil: AEGIS_REWARDS_START + 50n * WEEK,
			tokenTotal: BETA_TOKEN_TOTAL + paid,
			sentinelTokenTotal: 0n,
		});
		const amount = await totalRewardsAmount({
			rewardPeriodStart: AEGIS_REWARDS_START + 50n * WEEK,
			rewardPeriodEnd: AEGIS_REWARDS_START + 52n * WEEK,
			record: last,
		});
		expect(amount).toBe(192307692307692307692315n);
		expect(paid + amount).toBe(AEGIS_VALIDATOR_REWARDS);

		// Nothing is left once the 52 weeks have been paid.
		const done = await createAegisRecord({
			rewardsUntil: AEGIS_REWARDS_START + 52n * WEEK,
			tokenTotal: BETA_TOKEN_TOTAL + paid + amount,
			sentinelTokenTotal: 0n,
		});
		expect(
			await totalRewardsAmount({
				rewardPeriodStart: AEGIS_REWARDS_START + 52n * WEEK,
				rewardPeriodEnd: AEGIS_REWARDS_START + 54n * WEEK,
				record: done,
			}),
		).toBe(0n);
	});
});

describe("sentinelRewardsAmount", () => {
	it("uses the overridden per-sentinel amount", () => {
		expect(sentinelRewardsAmount({ sentinelRewards: 42n })).toBe(42n);
	});

	it("computes the per-sentinel amount for a default two-week period", () => {
		// 400,000 SAFE per year, i.e. 2/52 of that for a two week period.
		expect(sentinelRewardsAmount({})).toBe(15384615384615384615384n);
	});

	it("prorates by the actual period duration", () => {
		expect(
			sentinelRewardsAmount({
				rewardPeriodStart: AEGIS_REWARDS_START,
				rewardPeriodEnd: AEGIS_REWARDS_START + WEEK,
			}),
		).toBe(7692307692307692307692n);
	});
});
