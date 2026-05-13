import { describe, expect, it } from "vitest";
import { attestedTransaction } from "./harness/presets.js";
import { createTestSafenet } from "./harness/scenario.js";
import { emptyBlocks, namedAddress, parseSafe } from "./harness/utils.js";

describe("self-rewards", () => {
	it("routes commissions based on validator staker and beneficiary configuration", async () => {
		const safenet = await createTestSafenet({
			staking: {
				slots: [
					{
						events: [
							// Register all 4 validators.
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
								name: "ValidatorUpdated",
								validator: namedAddress("validator4"),
								isRegistered: true,
							},
							// Validator 1: self-stakes as validator — commission has no
							// beneficiary set, so it falls back to the staker (validator1).
							{
								name: "StakeIncreased",
								staker: namedAddress("validator1"),
								validator: namedAddress("validator1"),
								amount: parseSafe("3500000"),
							},
							// Validator 2: separate staker, no beneficiary — commission
							// falls back to the staker (staker2).
							{
								name: "StakeIncreased",
								staker: namedAddress("staker2"),
								validator: namedAddress("validator2"),
								amount: parseSafe("3500000"),
							},
							// Validator 3: separate staker with a beneficiary — commission
							// goes to beneficiary3.
							{
								name: "StakeIncreased",
								staker: namedAddress("staker3"),
								validator: namedAddress("validator3"),
								amount: parseSafe("3500000"),
							},
							{
								name: "SetDelegate",
								delegator: namedAddress("staker3"),
								delegate: namedAddress("beneficiary3"),
							},
							// Validator 4: separate staker sets a beneficiary that gets
							// cleared partway through the period — commission falls back to
							// the staker (staker4).
							{
								name: "StakeIncreased",
								staker: namedAddress("staker4"),
								validator: namedAddress("validator4"),
								amount: parseSafe("3500000"),
							},
							{
								name: "SetDelegate",
								delegator: namedAddress("staker4"),
								delegate: namedAddress("beneficiary4"),
							},
							// Delegate adds equal stake to all 4 validators.
							{
								name: "StakeIncreased",
								staker: namedAddress("delegate"),
								validator: namedAddress("validator1"),
								amount: parseSafe("1000000"),
							},
							{
								name: "StakeIncreased",
								staker: namedAddress("delegate"),
								validator: namedAddress("validator2"),
								amount: parseSafe("1000000"),
							},
							{
								name: "StakeIncreased",
								staker: namedAddress("delegate"),
								validator: namedAddress("validator3"),
								amount: parseSafe("1000000"),
							},
							{
								name: "StakeIncreased",
								staker: namedAddress("delegate"),
								validator: namedAddress("validator4"),
								amount: parseSafe("1000000"),
							},
						],
					},
					...emptyBlocks(5),
					// Staker4 clears their beneficiary partway through the period
					// causing the commission to be sent to the validator's staker.
					{
						assertTimestamp: 72n,
						events: [
							{
								name: "ClearDelegate",
								delegator: namedAddress("staker4"),
								delegate: namedAddress("beneficiary4"),
							},
						],
					},
					...emptyBlocks(4, { assertTimestamp: 120n }),
				],
			},
			consensus: {
				slots: [
					{
						events: [
							{
								name: "ValidatorStakerSet",
								validator: namedAddress("validator1"),
								staker: namedAddress("validator1"),
							},
							{
								name: "ValidatorStakerSet",
								validator: namedAddress("validator2"),
								staker: namedAddress("staker2"),
							},
							{
								name: "ValidatorStakerSet",
								validator: namedAddress("validator3"),
								staker: namedAddress("staker3"),
							},
							{
								name: "ValidatorStakerSet",
								validator: namedAddress("validator4"),
								staker: namedAddress("staker4"),
							},
							{ name: "KeyGenConfirmed", participant: namedAddress("validator1") },
							{ name: "KeyGenConfirmed", participant: namedAddress("validator2") },
							{ name: "KeyGenConfirmed", participant: namedAddress("validator3") },
							{ name: "KeyGenConfirmed", participant: namedAddress("validator4") },
						],
					},
					...emptyBlocks(11),
					{
						assertTimestamp: 60n,
						events: attestedTransaction({
							epoch: 1n,
							seed: "1",
							participants: ["validator1", "validator2", "validator3", "validator4"],
						}),
					},
					...emptyBlocks(12, { assertTimestamp: 120n }),
				],
			},
		});

		// 4 validators, each with total stake 4.5M SAFE (3.5M self + 1M delegate).
		// All participate in 1 transaction at 100%, so each receives 25% of rewards.
		//
		// Per validator (25,000 SAFE):
		//   self-stake reward = 25,000 × 3.5M/4.5M ≈ 19,444.44 SAFE
		//   delegate reward   = 25,000 × 1.0M/4.5M ≈  5,555.56 SAFE
		//   commission (5%)   ≈    277.78 SAFE
		//   net delegate      ≈  5,277.78 SAFE
		//
		// Commission routing:
		//   Validator  | Staker  | Beneficiary         | Commissions Receiver
		//  ------------+---------+---------------------+----------------------
		//   validator1 | null    | null                | validator1
		//   validator2 | staker2 | null                | staker2
		//   validator3 | staker3 | beneficiary3        | beneficiary3
		//   validator4 | staker4 | beneficiary4 → null | staker4

		const { payouts, unpaid } = await safenet.rewards(
			{ fromTimestamp: 60n, toTimestamp: 120n },
			parseSafe("100000"),
		);

		const validatorReward = parseSafe("19444.444444444444444444");
		const commission = parseSafe("277.777777777777777777");
		const delegateReward = parseSafe("5277.777777777777777778");
		expect(payouts).toEqual({
			[namedAddress("validator1")]: { stakeRewards: validatorReward, commission },
			[namedAddress("staker2")]: { stakeRewards: validatorReward, commission },
			[namedAddress("staker3")]: { stakeRewards: validatorReward, commission: 0n },
			[namedAddress("beneficiary3")]: { stakeRewards: 0n, commission },
			[namedAddress("staker4")]: { stakeRewards: validatorReward, commission },
			[namedAddress("delegate")]: { stakeRewards: 4n * delegateReward, commission: 0n },
		});
		expect(unpaid).toBe(4n);
	});
});
