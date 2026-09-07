import { describe, expect, it } from "vitest";
import { sentinelRequest } from "./harness/presets.js";
import { createTestSafenet } from "./harness/scenario.js";
import { emptyBlocks, namedAddress, requestId } from "./harness/utils.js";

describe("sentinel-participation", () => {
	it("attributes reveals to the period of the request they answer", async () => {
		const safenet = await createTestSafenet({
			staking: {
				slots: emptyBlocks(4, { assertTimestamp: 36n }),
			},
			consensus: {
				slots: [
					{
						// Before the period, so neither this request nor its
						// reveals are counted.
						events: sentinelRequest({ seed: "0", reveals: ["sentinel1", "sentinel2"] }),
					},
					...emptyBlocks(1),
					{
						assertTimestamp: 10n,
						events: sentinelRequest({ seed: "1", reveals: ["sentinel1", "sentinel2"] }),
					},
					{
						events: [{ name: "NewRequest", requestId: requestId("2") }],
					},
					{
						events: [
							{
								name: "Revealed",
								requestId: requestId("2"),
								sentinel: namedAddress("sentinel1"),
								approved: true,
							},
						],
					},
					{
						assertTimestamp: 25n,
						events: sentinelRequest({ seed: "3", reveals: ["sentinel1"] }),
					},
					...emptyBlocks(1, { assertTimestamp: 30n }),
					{
						assertTimestamp: 35n,
						events: [
							// This reveal answers a request from the previous
							// period, so it counts towards that period.
							{
								name: "Revealed",
								requestId: requestId("3"),
								sentinel: namedAddress("sentinel2"),
								approved: false,
							},
							// After the period, so neither this request nor its
							// reveals are counted.
							...sentinelRequest({ seed: "4", reveals: ["sentinel1", "sentinel2"] }),
						],
					},
					...emptyBlocks(1, { assertTimestamp: 40n }),
				],
			},
		});

		// Index the whole chain first: `sentinelParticipation` only ever
		// indexes up to the end of the period it is asked about, so the reveal
		// landing after the period boundary needs a later indexing run to be
		// visible at all - which is exactly what happens in practice, where
		// rewards are computed for a period that has long since closed.
		await safenet.index();

		// Requests created in [10, 30] are "1" (t=10), "2" (t=15) and "3"
		// (t=25), so the denominator is 3. sentinel1 revealed for all three,
		// while sentinel2 only revealed for "1" and for "3" - the latter after
		// the period had already ended.
		const participation = await safenet.sentinelParticipation({
			fromTimestamp: 10n,
			toTimestamp: 30n,
		});
		expect(participation).toEqual({
			total: 3,
			sentinels: {
				[namedAddress("sentinel1")]: 3,
				[namedAddress("sentinel2")]: 2,
			},
		});
	});

	it("skips reveals for requests created before the oracle start block", async () => {
		const safenet = await createTestSafenet({
			staking: {
				slots: emptyBlocks(3, { assertTimestamp: 24n }),
			},
			consensus: {
				slots: [
					{
						// Block 1, before the indexer's start block, so this
						// request is never indexed.
						events: [{ name: "NewRequest", requestId: requestId("early") }],
					},
					...emptyBlocks(1),
					{
						// Block 3, the first indexed block. The request this
						// answers is unknown, so the reveal is dropped instead
						// of failing on the missing foreign key.
						assertTimestamp: 10n,
						events: [
							{
								name: "Revealed",
								requestId: requestId("early"),
								sentinel: namedAddress("sentinel1"),
								approved: true,
							},
						],
					},
					{
						assertTimestamp: 15n,
						events: sentinelRequest({ seed: "1", reveals: ["sentinel1"] }),
					},
					...emptyBlocks(1, { assertTimestamp: 20n }),
				],
			},
			sentinelOracleStartBlock: 3n,
		});

		// Only request "1" made it into the denominator, and the reveal for the
		// unindexed request is missing from the numerator as well.
		const participation = await safenet.sentinelParticipation({
			fromTimestamp: 0n,
			toTimestamp: 20n,
		});
		expect(participation).toEqual({
			total: 1,
			sentinels: {
				[namedAddress("sentinel1")]: 1,
			},
		});
	});

	it("reports empty participation for a period without requests", async () => {
		const safenet = await createTestSafenet({
			staking: {
				slots: emptyBlocks(2, { assertTimestamp: 12n }),
			},
			consensus: {
				slots: [
					{
						events: sentinelRequest({ seed: "0", reveals: ["sentinel1"] }),
					},
					...emptyBlocks(2, { assertTimestamp: 10n }),
				],
			},
		});

		// The only request was created at t=0, so the period has an empty
		// denominator and no sentinel rates to compute.
		const participation = await safenet.sentinelParticipation({
			fromTimestamp: 5n,
			toTimestamp: 10n,
		});
		expect(participation).toEqual({
			total: 0,
			sentinels: {},
		});
	});
});
