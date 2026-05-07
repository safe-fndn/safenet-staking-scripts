import { describe, expect, it, vi } from "vitest";
import { totalRewardsAmount } from "./args.js";

const dateToTimestamp = (date: string): bigint => BigInt(new Date(date).getTime() / 1000);

describe("totalRewardsAmount", () => {
	it("uses the overridden total rewards amount", async () => {
		expect(await totalRewardsAmount({ totalRewards: 42n })).toBe(42n);
	});

	it("computes the per-period amount for a default two-week period", async () => {
		expect(await totalRewardsAmount({})).toBe(346153846153846153846153n);
	});

	it("prorates by the actual period duration", async () => {
		const start = dateToTimestamp("2026-04-07T00:00:00.000Z");
		expect(
			await totalRewardsAmount({
				rewardPeriodStart: start,
				rewardPeriodEnd: start + 60n * 60n * 24n * 7n, // one week
			}),
		).toBe(173076923076923076923076n);
	});

	it("accounts for past distributions when --record is set", async () => {
		// The rewards after the first payout period.
		// <https://github.com/safe-fndn/safenet-beta-data/blob/b392639bfc5e2547f1e9cabddd9b3e7c0425027d/assets/rewards/latest.json>
		vi.mock(import("../merkledb/index.js"), () => {
			const MerkleDb = vi.fn(
				class {
					index = vi.fn(async () => ({
						tokenTotal: 346151474022931470997436n,
						rewardsUntil: new Date("2026-04-21T00:00:00.000Z"),
					}));
				},
			);

			return { MerkleDb } as unknown as typeof import("../merkledb/index.js");
		});

		// The total rewards amount used for the second payout period. Note that the
		// expected amount is **1 wei larger than what was actually used**! This is
		// because our payout process did not account for rounding: if we only paid
		// `floor(4.5M / 13)` per payout period, we would be left with exactly 11
		// wei from the total payout allocation that would not be used. As such, 11
		// of the 13 payouts will need an additional wei added to the total amount
		// so that we use the exact 4.5M tokens by the last payout. The logic for
		// computing the total rewards amount accounts for this correctly.
		// <https://github.com/safe-fndn/safenet-beta-data/pull/24>
		expect(
			await totalRewardsAmount({
				rewardPeriodStart: dateToTimestamp("2026-04-21T00:00:00.000Z"),
				rewardPeriodEnd: dateToTimestamp("2026-05-05T00:00:00.000Z"),
				record: "/tmp/record",
			}),
		).toBe(346156218284760836694871n);
	});
});
