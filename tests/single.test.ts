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

describe("single", () => {
	it("distributes rewards between staker and delegate with commission", async () => {
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
							{
								name: "StakeIncreased",
								staker: namedAddress("staker"),
								validator: namedAddress("validator"),
								amount: parseSafe("3500000"),
							},
							{
								name: "StakeIncreased",
								staker: namedAddress("delegate"),
								validator: namedAddress("validator"),
								amount: parseSafe("1000000"),
							},
						],
					},
					...emptyBlocks(10, { assertTimestamp: 120n }),
				],
			},
			consensus: {
				slots: [
					{
						events: [
							{
								name: "ValidatorStakerSet",
								validator: namedAddress("validator"),
								staker: namedAddress("staker"),
							},
							{
								name: "KeyGenConfirmed",
								participant: namedAddress("validator"),
							},
						],
					},
					...emptyBlocks(11),
					{
						assertTimestamp: 60n,
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
						],
					},
					...emptyBlocks(12, { assertTimestamp: 120n }),
				],
			},
		});

		// With totalStake=4.5M and one validator at 100% participation, all
		// rewards go to this validator. The split is:
		//
		//   self reward      = 100_000 * 3.5M / 4.5M  ≈ 77_777.78 SAFE
		//   delegate reward  = 100_000 * 1.0M / 4.5M  ≈ 22_222.22 SAFE
		//   commission       ≈ 1_111.11 SAFE
		//   ---
		//   validator payout ≈ 78_888.89 SAFE
		//   delegate payout  ≈ 21_111.11 SAFE

		const { payouts, unpaid } = await safenet.rewards(
			{ fromTimestamp: 60n, toTimestamp: 120n },
			parseSafe("100000"),
		);
		expect(payouts).toEqual({
			[namedAddress("staker")]: parseSafe("78888.888888888888888888"),
			[namedAddress("delegate")]: parseSafe("21111.111111111111111111"),
		});
		expect(unpaid).toBe(1n); // rounding residue
	});
});
