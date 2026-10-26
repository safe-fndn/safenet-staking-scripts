import { describe, expect, it } from "vitest";
import { SETTLEMENT_BLOCKS } from "../src/safenet.js";
import { sentinelRequest } from "./harness/presets.js";
import { createTestSafenet, type Scenario } from "./harness/scenario.js";
import { emptyBlocks, namedAddress, requestId } from "./harness/utils.js";

describe("sentinel-participation", () => {
	it("attributes reveals to the period of the request they answer", async () => {
		const safenet = await createTestSafenet({
			staking: {
				slots: [
					// Up to the settlement timestamp, as every indexer is updated to it.
					...emptyBlocks(24, { assertTimestamp: 276n }),
				],
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
					// Up to the settlement block 7 + 48 = 55 of the period.
					...emptyBlocks(Number(SETTLEMENT_BLOCKS) - 2),
				],
			},
		});

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
				slots: emptyBlocks(23, { assertTimestamp: 264n }),
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
					...emptyBlocks(Number(SETTLEMENT_BLOCKS)),
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
				slots: emptyBlocks(22, { assertTimestamp: 252n }),
			},
			consensus: {
				slots: [
					{
						events: sentinelRequest({ seed: "0", reveals: ["sentinel1"] }),
					},
					...emptyBlocks(2, { assertTimestamp: 10n }),
					...emptyBlocks(Number(SETTLEMENT_BLOCKS)),
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

	describe("settlement", () => {
		// The period [0, 10] ends with block 3 (t=10), so it settles at block
		// 3 + 48 = 51 (t=250). The scenario has a late reveal for request "2"
		// exactly at the settlement block, and one just after it.
		const lateReveal = (sentinel: string) => ({
			name: "Revealed" as const,
			requestId: requestId("2"),
			sentinel: namedAddress(sentinel),
			approved: true,
		});
		const scenario = ({ settled }: { settled: boolean }): Scenario => ({
			staking: {
				slots: emptyBlocks(22, { assertTimestamp: 252n }),
			},
			consensus: {
				slots: [
					{
						events: sentinelRequest({
							seed: "1",
							reveals: ["sentinel1", "sentinel2", "sentinel3"],
						}),
					},
					...emptyBlocks(1),
					{
						assertTimestamp: 10n,
						events: sentinelRequest({ seed: "2", reveals: ["sentinel1"] }),
					},
					...emptyBlocks(Number(SETTLEMENT_BLOCKS) - 1, { assertTimestamp: 245n }),
					...(settled
						? [
								{ assertTimestamp: 250n, events: [lateReveal("sentinel2")] },
								{ assertTimestamp: 255n, events: [lateReveal("sentinel3")] },
								...emptyBlocks(10, { assertTimestamp: 305n }),
							]
						: []),
				],
			},
		});
		const period = { fromTimestamp: 0n, toTimestamp: 10n };

		it("counts a reveal exactly at the settlement block", async () => {
			const safenet = await createTestSafenet(scenario({ settled: true }));

			expect(await safenet.settlement(period)).toEqual({
				boundaryBlock: 3n,
				settlementBlock: 51n,
				settlementTimestamp: 250n,
			});

			// sentinel2 revealed for request "2" in the settlement block itself,
			// so it is credited for both requests.
			const participation = await safenet.sentinelParticipation(period);
			expect(participation.total).toBe(2);
			expect(participation.sentinels[namedAddress("sentinel2")]).toBe(2);
		});

		it("ignores a reveal after the settlement block however far the chain is indexed", async () => {
			// One database is only indexed as far as the settlement requires,
			// the other one up to the head of the chain, well past the reveal
			// one block after the settlement block. Note that the former still
			// indexes block 52, as it is part of the same block page as the
			// settlement block 51.
			const settled = await createTestSafenet(scenario({ settled: true }));
			const indexed = await createTestSafenet(scenario({ settled: true }));
			await indexed.index();

			// sentinel3 revealed for request "2" one block too late, so it is
			// only credited for request "1".
			const expected = {
				total: 2,
				sentinels: {
					[namedAddress("sentinel1")]: 2,
					[namedAddress("sentinel2")]: 2,
					[namedAddress("sentinel3")]: 1,
				},
			};
			expect(await settled.sentinelParticipation(period)).toEqual(expected);
			expect(await indexed.sentinelParticipation(period)).toEqual(expected);
		});

		it("fails while the settlement block does not exist yet", async () => {
			// The chain ends with block 50, one block short of the settlement.
			const safenet = await createTestSafenet(scenario({ settled: false }));

			await expect(safenet.settlement(period)).rejects.toThrow(
				"settlement block 51 does not exist yet",
			);
			await expect(safenet.sentinelParticipation(period)).rejects.toThrow(
				"settlement block 51 does not exist yet",
			);
		});
	});
});
