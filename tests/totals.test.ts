import { describe, expect, it } from "vitest";
import { sentinelRequest } from "./harness/presets.js";
import { createTestSafenet } from "./harness/scenario.js";
import { emptyBlocks, namedAddress, requestId, transaction } from "./harness/utils.js";

describe("totals", () => {
	it("counts sentinel verdicts but not timed-out or disputed requests", async () => {
		const safenet = await createTestSafenet({
			staking: {
				slots: emptyBlocks(1),
			},
			consensus: {
				slots: [
					{
						// No sentinel revealed, so the request timed out. It is
						// created before the verdicts, so a verdict that marks more
						// than its own request is caught.
						events: [
							{ name: "TransactionProposed", epoch: 1n, transaction: transaction("timed-out") },
							{ name: "NewRequest", requestId: requestId("timed-out") },
						],
					},
					{
						events: [
							{ name: "TransactionProposed", epoch: 1n, transaction: transaction("approved") },
							...sentinelRequest({ seed: "approved", reveals: ["sentinel1"] }),
							{ name: "OracleResult", requestId: requestId("approved"), approved: true },
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
							{ name: "OracleResult", requestId: requestId("denied"), approved: false },
						],
					},
					{
						// Sentinels revealed both ways, so the request was frozen for
						// arbitration.
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

		// Four proposals and four oracle requests, but only the approved and the
		// denied request reached a verdict.
		const { transactions } = await safenet.totals();
		expect(transactions).toBe(2);
	});

	it("skips verdicts for requests created before the oracle start block", async () => {
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
						// Block 2, the first indexed block. The last verdict answers
						// the unknown request and must not be counted. It comes after
						// the known verdict, so a stray row for it cannot take that
						// verdict's key and go unnoticed.
						events: [
							...sentinelRequest({ seed: "1", reveals: ["sentinel1"] }),
							{ name: "OracleResult", requestId: requestId("1"), approved: true },
							{ name: "OracleResult", requestId: requestId("early"), approved: true },
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
