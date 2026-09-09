import { describe, expect, it } from "vitest";
import { sentinelRequest } from "./harness/presets.js";
import { createTestSafenet } from "./harness/scenario.js";
import { emptyBlocks, namedAddress, parseSafe } from "./harness/utils.js";

// The per-sentinel grant for a two week period, i.e. the 400,000 SAFE annual
// grant prorated over 2/52 of a year. Computing it is the job of the CLI, so
// the exact figure does not matter here - only that eligible sentinels get all
// of it and ineligible ones get none of it.
const PER_SENTINEL = parseSafe("15384.615384615384615384");

describe("sentinel-rewards", () => {
	it("pays the full grant to every sentinel at or above the participation threshold", async () => {
		const safenet = await createTestSafenet({
			staking: {
				slots: emptyBlocks(4, { assertTimestamp: 36n }),
			},
			consensus: {
				slots: [
					...emptyBlocks(2, { assertTimestamp: 5n }),
					{
						assertTimestamp: 10n,
						events: sentinelRequest({
							seed: "1",
							reveals: ["sentinel1", "sentinel2", "sentinel3"],
						}),
					},
					{
						events: sentinelRequest({
							seed: "2",
							reveals: ["sentinel1", "sentinel2", "sentinel3"],
						}),
					},
					{
						events: sentinelRequest({
							seed: "3",
							reveals: ["sentinel1", "sentinel2", "sentinel3"],
						}),
					},
					{
						events: sentinelRequest({ seed: "4", reveals: ["sentinel1", "sentinel2"] }),
					},
					{
						assertTimestamp: 30n,
						events: sentinelRequest({ seed: "5", reveals: ["sentinel1"] }),
					},
				],
			},
		});

		// Five requests in [10, 30], answered by sentinel1 five times (100%),
		// by sentinel2 four times (80%) and by sentinel3 three times (60%). So
		// only sentinel3 misses the 70% threshold, and the two sentinels above
		// it receive the identical full grant - the amount does not scale with
		// the participation rate.
		const { payouts, forfeited } = await safenet.sentinelRewards(
			{ fromTimestamp: 10n, toTimestamp: 30n },
			PER_SENTINEL,
		);
		expect(payouts).toEqual({
			[namedAddress("sentinel1")]: PER_SENTINEL,
			[namedAddress("sentinel2")]: PER_SENTINEL,
		});
		expect(forfeited).toBe(PER_SENTINEL);
	});

	it("treats a sentinel exactly at the participation threshold as eligible", async () => {
		const safenet = await createTestSafenet({
			staking: {
				slots: emptyBlocks(3, { assertTimestamp: 24n }),
			},
			consensus: {
				slots: [
					{
						assertTimestamp: 0n,
						events: [
							...sentinelRequest({ seed: "1", reveals: ["sentinel1", "sentinel2"] }),
							...sentinelRequest({ seed: "2", reveals: ["sentinel1", "sentinel2"] }),
						],
					},
					{
						events: [
							...sentinelRequest({ seed: "3", reveals: ["sentinel1", "sentinel2"] }),
							...sentinelRequest({ seed: "4", reveals: ["sentinel1", "sentinel2"] }),
						],
					},
					{
						events: [
							...sentinelRequest({ seed: "5", reveals: ["sentinel1", "sentinel2"] }),
							...sentinelRequest({ seed: "6", reveals: ["sentinel1", "sentinel2"] }),
						],
					},
					{
						events: [
							...sentinelRequest({ seed: "7", reveals: ["sentinel1"] }),
							// Requests that nobody answered still count towards
							// the denominator.
							...sentinelRequest({ seed: "8", reveals: [] }),
						],
					},
					{
						assertTimestamp: 20n,
						events: [
							...sentinelRequest({ seed: "9", reveals: [] }),
							...sentinelRequest({ seed: "10", reveals: [] }),
						],
					},
				],
			},
		});

		// Ten requests in [0, 20], answered by sentinel1 seven times and by
		// sentinel2 six times. The threshold is inclusive, so sentinel1 is
		// eligible at exactly 70% while sentinel2 forfeits its grant at 60%.
		const { payouts, forfeited } = await safenet.sentinelRewards(
			{ fromTimestamp: 0n, toTimestamp: 20n },
			PER_SENTINEL,
		);
		expect(payouts).toEqual({
			[namedAddress("sentinel1")]: PER_SENTINEL,
		});
		expect(forfeited).toBe(PER_SENTINEL);
	});

	it("pays and forfeits nothing for a period without requests", async () => {
		const safenet = await createTestSafenet({
			staking: {
				slots: emptyBlocks(2, { assertTimestamp: 12n }),
			},
			consensus: {
				slots: [
					{
						events: sentinelRequest({ seed: "1", reveals: ["sentinel1"] }),
					},
					...emptyBlocks(2, { assertTimestamp: 10n }),
				],
			},
		});

		// The only request was created at t=0, so the period has an empty
		// denominator and there is no participation rate to compute. Nothing is
		// forfeited either: with no requests, there is nothing a sentinel could
		// have failed to answer.
		const { payouts, forfeited } = await safenet.sentinelRewards(
			{ fromTimestamp: 5n, toTimestamp: 10n },
			PER_SENTINEL,
		);
		expect(payouts).toEqual({});
		expect(forfeited).toBe(0n);
	});
});
