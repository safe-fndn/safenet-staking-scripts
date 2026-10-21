import { describe, expect, it } from "vitest";
import { sentinelRequest } from "./harness/presets.js";
import { createTestSafenet } from "./harness/scenario.js";
import { emptyBlocks, namedAddress, requestId, transaction } from "./harness/utils.js";

describe("totals", () => {
	it("counts sentinel requests with at least one reveal", async () => {
		const safenet = await createTestSafenet({
			staking: {
				slots: emptyBlocks(1),
			},
			consensus: {
				slots: [
					{
						// No sentinel revealed, so the request timed out.
						events: [
							{ name: "TransactionProposed", epoch: 1n, transaction: transaction("timed-out") },
							{ name: "NewRequest", requestId: requestId("timed-out") },
						],
					},
					{
						events: [
							{ name: "TransactionProposed", epoch: 1n, transaction: transaction("approved") },
							...sentinelRequest({ seed: "approved", reveals: ["sentinel1", "sentinel2"] }),
						],
					},
					{
						events: [
							{ name: "TransactionProposed", epoch: 1n, transaction: transaction("denied") },
							{ name: "NewRequest", requestId: requestId("denied") },
							{
								name: "Revealed",
								requestId: requestId("denied"),
								sentinel: namedAddress("sentinel1"),
								approved: false,
							},
						],
					},
					{
						// Sentinels revealed both ways, so the request was frozen for
						// arbitration, but it was still checked.
						events: [
							{ name: "TransactionProposed", epoch: 1n, transaction: transaction("disputed") },
							{ name: "NewRequest", requestId: requestId("disputed") },
							{
								name: "Revealed",
								requestId: requestId("disputed"),
								sentinel: namedAddress("sentinel1"),
								approved: true,
							},
							{
								name: "Revealed",
								requestId: requestId("disputed"),
								sentinel: namedAddress("sentinel2"),
								approved: false,
							},
						],
					},
				],
			},
		});

		// Four proposals and four oracle requests, but the timed-out request has
		// no reveal. Requests with several reveals are counted once.
		const { transactions } = await safenet.totals();
		expect(transactions).toBe(3);
	});

	it("skips reveals for requests created before the oracle start block", async () => {
		const safenet = await createTestSafenet({
			staking: {
				slots: emptyBlocks(1),
			},
			consensus: {
				slots: [
					{
						// Block 1, before the indexer's start block, so this
						// request is never indexed.
						events: [{ name: "NewRequest", requestId: requestId("early") }],
					},
					{
						// Block 2, the first indexed block. The last reveal answers
						// the unknown request and must not be counted.
						events: [
							...sentinelRequest({ seed: "1", reveals: ["sentinel1"] }),
							{
								name: "Revealed",
								requestId: requestId("early"),
								sentinel: namedAddress("sentinel1"),
								approved: true,
							},
						],
					},
				],
			},
			sentinelOracleStartBlock: 2n,
		});

		const { transactions } = await safenet.totals();
		expect(transactions).toBe(1);
	});
});
