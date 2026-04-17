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

describe("participation", () => {
	it("distributes rewards by participation-weighted stake and applies commission rules", async () => {
		const attestedTransaction = ({
			epoch,
			seed,
			participants,
		}: {
			epoch: bigint;
			seed: string;
			participants: string[];
		}) => ({
			events: [
				{
					name: "TransactionProposed" as const,
					epoch,
					transaction: transaction(seed),
				},
				{
					name: "Sign" as const,
					sid: signatureId(seed, 1n),
					message: transactionProposalMessage({
						epoch,
						safeTxHash: safeTxHash(transaction(seed)),
					}),
				},
				...participants.map((participant) => ({
					name: "SignShared" as const,
					sid: signatureId(seed, 1n),
					selectionRoot: selectionRoot(`${seed}:1`),
					participant: namedAddress(participant),
				})),
				{
					name: "SignCompleted" as const,
					sid: signatureId(seed, 1n),
					selectionRoot: selectionRoot(`${seed}:1`),
				},
				{
					name: "TransactionAttested" as const,
					sid: signatureId(seed, 1n),
				},
			],
		});

		const safenet = await createTestSafenet({
			staking: {
				slots: [
					{
						events: [
							{
								name: "ValidatorUpdated",
								validator: namedAddress("validator1"),
								isRegistered: true,
							},
							{
								name: "ValidatorUpdated",
								validator: namedAddress("validator2"),
								isRegistered: true,
							},
							{
								name: "ValidatorUpdated",
								validator: namedAddress("validator3"),
								isRegistered: true,
							},
							{
								name: "StakeIncreased",
								staker: namedAddress("staker1"),
								validator: namedAddress("validator1"),
								amount: parseSafe("3500000"),
							},
							{
								name: "StakeIncreased",
								staker: namedAddress("delegate1"),
								validator: namedAddress("validator1"),
								amount: parseSafe("1000000"),
							},
							{
								name: "StakeIncreased",
								staker: namedAddress("delegate2"),
								validator: namedAddress("validator2"),
								amount: parseSafe("1000000"),
							},
							{
								name: "StakeIncreased",
								staker: namedAddress("staker3"),
								validator: namedAddress("validator3"),
								amount: parseSafe("3500000"),
							},
							{
								name: "StakeIncreased",
								staker: namedAddress("delegate3"),
								validator: namedAddress("validator3"),
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
								validator: namedAddress("validator1"),
								staker: namedAddress("staker1"),
							},
							{
								name: "ValidatorStakerSet",
								validator: namedAddress("validator2"),
								staker: namedAddress("operator2"),
							},
							{
								name: "ValidatorStakerSet",
								validator: namedAddress("validator3"),
								staker: namedAddress("staker3"),
							},
							{ name: "KeyGenConfirmed", participant: namedAddress("validator1") },
							{ name: "KeyGenConfirmed", participant: namedAddress("validator2") },
							{ name: "KeyGenConfirmed", participant: namedAddress("validator3") },
						],
					},
					...emptyBlocks(11),
					attestedTransaction({
						epoch: 1n,
						seed: "1",
						participants: ["validator1", "validator2", "validator3"],
					}),
					attestedTransaction({
						epoch: 2n,
						seed: "2",
						participants: ["validator1", "validator2", "validator3"],
					}),
					attestedTransaction({
						epoch: 3n,
						seed: "3",
						participants: ["validator1", "validator2", "validator3"],
					}),
					attestedTransaction({
						epoch: 4n,
						seed: "4",
						participants: ["validator1", "validator2"],
					}),
					attestedTransaction({
						epoch: 5n,
						seed: "5",
						participants: ["validator1"],
					}),
					...emptyBlocks(8, { assertTimestamp: 120n }),
				],
			},
		});

		// All 3 validators are active for the full period with average stakes:
		//   validator1 = 4.5M SAFE (3.5M self + 1M delegated), participation 5/5
		//   validator2 = 1.0M SAFE (delegated only),           participation 4/5
		//   validator3 = 4.5M SAFE (3.5M self + 1M delegated), participation 3/5
		//
		// Total network stake = 10M SAFE, so the linear threshold is 10M / 3.
		// The corresponding participation-weighted stake weights are:
		//
		//   validator1 = sqrt((10M / 3) * 4.5M) * 5/5
		//              ≈ 3,872,983.35 SAFE
		//   validator2 = 1.0M * 4/5
		//              =   800,000 SAFE
		//   validator3 = 0, because 3/5 = 60% is below the 75% participation threshold
		//
		// So for 100,000 SAFE total rewards:
		//   validator1 reward ≈ 82,880.32 SAFE
		//   validator2 reward ≈ 17,119.68 SAFE
		//   validator3 reward = 0
		//
		// validator1 has >= 3.5M SAFE self-stake, so its delegated reward pays a
		// 5% commission to staker1. validator2 has no self-stake, so delegate2
		// receives the full validator2 reward with no commission.

		const { payouts, unpaid } = await safenet.rewards(
			{ fromTimestamp: 60n, toTimestamp: 120n },
			parseSafe("100000"),
		);
		expect(payouts).toEqual({
			[namedAddress("staker1")]: parseSafe("65383.360100233574815986"),
			[namedAddress("delegate1")]: parseSafe("17496.955519780815795828"),
			[namedAddress("delegate2")]: parseSafe("17119.684379985609388185"),
		});
		expect(unpaid).toBe(1n);
	});
});
