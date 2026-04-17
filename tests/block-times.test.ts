import { describe, expect, it } from "vitest";
import { createTestSafenet } from "./harness/scenario.js";
import {
	emptyBlocks,
	namedAddress,
	parseSafe,
	safeTxHash,
	selectionRoot,
	signatureId,
	transaction,
	transactionProposalMessage,
} from "./harness/utils.js";

describe("block-times", () => {
	it("weights stake by the exact time inside the period instead of block boundaries", async () => {
		const safenet = await createTestSafenet({
			staking: {
				slots: [
					{
						events: [
							{
								name: "ValidatorUpdated",
								validator: namedAddress("validator"),
								isRegistered: true,
							},
						],
					},
					...emptyBlocks(5),
					{
						assertTimestamp: 72n,
						events: [
							{
								name: "StakeIncreased",
								staker: namedAddress("staker1"),
								validator: namedAddress("validator"),
								amount: parseSafe("1000"),
							},
							{
								name: "StakeIncreased",
								staker: namedAddress("staker2"),
								validator: namedAddress("validator"),
								amount: parseSafe("1000"),
							},
						],
					},
					{
						assertTimestamp: 84n,
						events: [
							{
								name: "WithdrawalInitiated",
								staker: namedAddress("staker2"),
								validator: namedAddress("validator"),
								amount: parseSafe("1000"),
							},
							{
								name: "StakeIncreased",
								staker: namedAddress("staker3"),
								validator: namedAddress("validator"),
								amount: parseSafe("1000"),
							},
						],
					},
					{
						assertTimestamp: 96n,
						events: [
							{
								name: "WithdrawalInitiated",
								staker: namedAddress("staker1"),
								validator: namedAddress("validator"),
								amount: parseSafe("1000"),
							},
							{
								name: "WithdrawalInitiated",
								staker: namedAddress("staker3"),
								validator: namedAddress("validator"),
								amount: parseSafe("1000"),
							},
						],
					},
				],
			},
			consensus: {
				slots: [
					{
						events: [
							{
								name: "ValidatorStakerSet",
								validator: namedAddress("validator"),
								staker: namedAddress("operator"),
							},
							{
								name: "KeyGenConfirmed",
								participant: namedAddress("validator"),
							},
						],
					},
					...emptyBlocks(16),
					{
						assertTimestamp: 85n,
						events: [
							{
								name: "TransactionProposed",
								epoch: 1n,
								transaction: transaction("valid"),
							},
							{
								name: "Sign",
								sid: signatureId("1", 1n),
								message: transactionProposalMessage({
									epoch: 1n,
									safeTxHash: safeTxHash(transaction("valid")),
								}),
							},
							{
								name: "SignShared",
								sid: signatureId("1", 1n),
								selectionRoot: selectionRoot("1:1"),
								participant: namedAddress("validator"),
							},
							{
								name: "SignCompleted",
								sid: signatureId("1", 1n),
								selectionRoot: selectionRoot("1:1"),
							},
							{
								name: "TransactionAttested",
								sid: signatureId("1", 1n),
							},
						],
					},
					...emptyBlocks(1, { assertTimestamp: 90n }),
				],
			},
		});

		// Reward period is [80, 90), while staking blocks land at 72, 84, and 96.
		// The average delegated stake must therefore be sliced by the exact period
		// bounds, not by full blocks:
		//
		//   staker1: active from 80 -> 90  = 10 seconds
		//   staker2: active from 80 -> 84  =  4 seconds
		//   staker3: active from 84 -> 90  =  6 seconds
		//
		// Total weighted stake = 20 stake-seconds, so with 20 SAFE rewards:
		//   staker1 = 10 SAFE
		//   staker2 =  4 SAFE
		//   staker3 =  6 SAFE

		const { payouts, unpaid } = await safenet.rewards(
			{ fromTimestamp: 80n, toTimestamp: 90n },
			parseSafe("20"),
		);
		expect(payouts).toEqual({
			[namedAddress("staker1")]: parseSafe("10"),
			[namedAddress("staker2")]: parseSafe("4"),
			[namedAddress("staker3")]: parseSafe("6"),
		});
		expect(unpaid).toBe(0n);
	});
});
