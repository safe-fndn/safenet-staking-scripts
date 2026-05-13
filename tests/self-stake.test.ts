import { describe, expect, it } from "vitest";
import { attestedTransaction } from "./harness/presets.js";
import { createTestSafenet } from "./harness/scenario.js";
import { emptyBlocks, namedAddress, parseSafe } from "./harness/utils.js";

describe("self-stake", () => {
	it("weights stake by validator active registration windows over the payout period", async () => {
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
								staker: namedAddress("staker2"),
								validator: namedAddress("validator1"),
								amount: parseSafe("50000000"),
							},
							// validator2 and validator3 are self-stakers.
							{
								name: "StakeIncreased",
								staker: namedAddress("validator2"),
								validator: namedAddress("validator2"),
								amount: parseSafe("3500000"),
							},
							{
								name: "StakeIncreased",
								staker: namedAddress("validator3"),
								validator: namedAddress("validator3"),
								amount: parseSafe("1000000"),
							},
							// one delegator for each validator
							{
								name: "StakeIncreased",
								staker: namedAddress("delegate1"),
								validator: namedAddress("validator1"),
								amount: parseSafe("420000"),
							},
							{
								name: "StakeIncreased",
								staker: namedAddress("delegate2"),
								validator: namedAddress("validator2"),
								amount: parseSafe("420000"),
							},
							{
								name: "StakeIncreased",
								staker: namedAddress("delegate3"),
								validator: namedAddress("validator3"),
								amount: parseSafe("420000"),
							},
						],
					},
					...emptyBlocks(2),
					{
						assertTimestamp: 36n,
						events: [
							{
								name: "ValidatorUpdated",
								validator: namedAddress("validator1"),
								isRegistered: false,
							},
						],
					},
					{
						assertTimestamp: 48n,
						events: [
							{
								name: "ValidatorUpdated",
								validator: namedAddress("validator1"),
								isRegistered: true,
							},
						],
					},
					...emptyBlocks(1),
					{
						assertTimestamp: 72n,
						events: [
							{
								name: "ValidatorUpdated",
								validator: namedAddress("validator1"),
								isRegistered: false,
							},
						],
					},
					{
						assertTimestamp: 84n,
						events: [
							{
								name: "ValidatorUpdated",
								validator: namedAddress("validator1"),
								isRegistered: true,
							},
						],
					},
					{ assertTimestamp: 96n },
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
								staker: namedAddress("validator2"),
							},
							{
								name: "ValidatorStakerSet",
								validator: namedAddress("validator3"),
								staker: namedAddress("validator3"),
							},
							{ name: "KeyGenConfirmed", participant: namedAddress("validator1") },
							{ name: "KeyGenConfirmed", participant: namedAddress("validator2") },
							{ name: "KeyGenConfirmed", participant: namedAddress("validator3") },
						],
					},
					...emptyBlocks(9),
					{
						assertTimestamp: 50n,
						events: attestedTransaction({
							epoch: 1n,
							seed: "1",
							participants: ["validator1", "validator2", "validator3"],
						}),
					},
					...emptyBlocks(1),
					{
						assertTimestamp: 60n,
						events: [
							{
								name: "ValidatorStakerSet",
								validator: namedAddress("validator1"),
								staker: namedAddress("staker2"),
							},
						],
					},
					...emptyBlocks(2),
					{
						assertTimestamp: 75n,
						events: [
							{
								name: "ValidatorStakerSet",
								validator: namedAddress("validator1"),
								staker: namedAddress("staker1"),
							},
						],
					},
					...emptyBlocks(2),
					{
						assertTimestamp: 90n,
					},
				],
			},
		});

		// Period [30, 90) = 60 s duration. All three validators have 100%
		// participation (1 transaction, all signed).
		//
		// validator1 is only registered during [30, 36], [48, 72], and [84, 90],
		// so all averages are computed over those 36 active seconds and then
		// divided by the full 60-second reward period.
		//
		// validator1 total stake while registered:
		//   staker1   3.5M for 36 s  →  avg =  2.100M SAFE
		//   staker2    50M for 36 s  →  avg = 30.000M SAFE
		//   delegate1 420K for 36 s  →  avg =  0.252M SAFE
		//   total                    →  avg = 32.352M SAFE
		//
		// validator1 self-stake follows the validator-staker setting on the
		// consensus chain:
		//   [30, 36] staker1  3.5M →  21.0M
		//   [48, 60] staker1  3.5M →  42.0M
		//   [60, 72] staker2   50M → 600.0M
		//   [84, 90] staker1  3.5M →  21.0M
		//   self weighted sum      → 684.0M
		//   self average stake     →  11.4M SAFE
		//
		// Broken down by staker on validator1:
		//   staker1 self     = 1.4M SAFE average
		//   staker1 delegate = 0.7M SAFE average
		//   staker2 self     =  10M SAFE average
		//   staker2 delegate =  20M SAFE average
		//   delegate1        = 252K SAFE average
		//
		// validator2 total = 3.92M SAFE (3.5M self + 420K delegate)
		// validator3 total = 1.42M SAFE (1.0M self + 420K delegate)
		//
		// Total network stake = 32.352M + 3.92M + 1.42M = 37.692M SAFE
		// Threshold T = 37.692M / 3 = 12.564M SAFE
		//
		// Stake weights (all at 100% participation):
		//   validator1: sqrt(12.564M × 32.352M) ≈ 20,161,114.25
		//   validator2: 3.92M
		//   validator3: 1.42M
		//
		// So for 100,000 SAFE total rewards:
		//   validator1 reward ≈ 79,059.739 SAFE
		//   validator2 reward ≈ 15,371.877 SAFE
		//   validator3 reward ≈  5,568.384 SAFE
		//
		// validator1 and validator2 both meet the 3.5M self-stake threshold, so
		// their delegated rewards pay a 5% commission to the validator
		// beneficiary. validator3 does not, so delegate3 receives its full share.
		//
		// Reward split by payee:
		//
		// validator1 (79,059.739 SAFE total):
		//   staker1 self reward     = 79,059.739 ×  1.4M / 32.352M
		//                           ≈ 3,421.230 SAFE
		//   staker1 delegate reward = 79,059.739 ×  0.7M / 32.352M
		//                           ≈ 1,710.615 SAFE
		//   staker2 self reward     = 79,059.739 × 10.0M / 32.352M
		//                           ≈ 24,437.357 SAFE
		//   staker2 delegate reward = 79,059.739 × 20.0M / 32.352M
		//                           ≈ 48,874.715 SAFE
		//   delegate1 reward        = 79,059.739 × 252K / 32.352M
		//                           ≈ 615.821 SAFE
		//   commission on delegated rewards
		//                           ≈  1,710.615 × 5% =    85.531 SAFE
		//                           ≈ 48,874.715 × 5% = 2,443.736 SAFE
		//                           ≈    615.821 × 5% =    30.791 SAFE
		//   ---
		//   staker1 payout          ≈ 3,421.230 + (1,710.615 - 85.531) + 85.531 + 2,443.736 + 30.791
		//                           ≈ 7,606.372 SAFE
		//   staker2 payout          ≈ 24,437.357 + (48,874.715 - 2,443.736)
		//                           ≈ 70,868.336 SAFE
		//   delegate1 payout        ≈ 615.821 - 30.791
		//                           ≈ 585.030 SAFE
		//
		// validator2 (15,371.877 SAFE total):
		//   validator2 self reward  = 15,371.877 × 3.5M / 3.92M
		//                           ≈ 13,724.890 SAFE
		//   delegate2 reward        = 15,371.877 × 420K / 3.92M
		//                           ≈ 1,646.987 SAFE
		//   commission              ≈ 1,646.987 × 5%
		//                           ≈ 82.349 SAFE
		//   ---
		//   validator2 payout       ≈ 13,724.890 + 82.349
		//                           ≈ 13,807.240 SAFE
		//   delegate2 payout        ≈ 1,646.987 - 82.349
		//                           ≈ 1,564.638 SAFE
		//
		// validator3 (5,568.384 SAFE total):
		//   validator3 self reward  = 5,568.384 × 1.0M / 1.42M
		//                           ≈ 3,921.397 SAFE
		//   delegate3 payout        = 5,568.384 × 420K / 1.42M
		//                           ≈ 1,646.987 SAFE

		const { payouts: rewardPayouts, unpaid } = await safenet.rewards(
			{ fromTimestamp: 30n, toTimestamp: 90n },
			parseSafe("100000"),
		);
		const payouts = Object.fromEntries(
			Object.entries(rewardPayouts).map(([addr, { stakeRewards, commission }]) => [
				addr,
				stakeRewards + commission,
			]),
		);
		expect(payouts).toEqual({
			[namedAddress("staker1")]: parseSafe("7606.371852805720730551"),
			[namedAddress("staker2")]: parseSafe("70868.336352684540636779"),
			[namedAddress("delegate1")]: parseSafe("585.030335270092380291"),
			[namedAddress("validator2")]: parseSafe("13807.239812356328549552"),
			[namedAddress("delegate2")]: parseSafe("1564.637513527456714363"),
			[namedAddress("validator3")]: parseSafe("3921.397277011169710182"),
			[namedAddress("delegate3")]: parseSafe("1646.986856344691278276"),
		});
		expect(unpaid).toBe(6n);
	});
});
