import { describe, expect, it } from "vitest";
import { attestedTransaction } from "./harness/presets.js";
import { createTestSafenet } from "./harness/scenario.js";
import { emptyBlocks, namedAddress, parseSafe } from "./harness/utils.js";

describe("fancy-delegates", () => {
	it("accounts for delegate stake changes with and without the self-stake commission threshold", async () => {
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
								name: "StakeIncreased",
								staker: namedAddress("staker1"),
								validator: namedAddress("validator1"),
								amount: parseSafe("3500000"),
							},
							{
								name: "StakeIncreased",
								staker: namedAddress("validator1-static"),
								validator: namedAddress("validator1"),
								amount: parseSafe("1400000"),
							},
							{
								name: "StakeIncreased",
								staker: namedAddress("validator1-exit"),
								validator: namedAddress("validator1"),
								amount: parseSafe("750000"),
							},
							{
								name: "StakeIncreased",
								staker: namedAddress("validator2-static"),
								validator: namedAddress("validator2"),
								amount: parseSafe("2500000"),
							},
							{
								name: "StakeIncreased",
								staker: namedAddress("validator2-exit"),
								validator: namedAddress("validator2"),
								amount: parseSafe("1500000"),
							},
						],
					},
					...emptyBlocks(5),
					{
						assertTimestamp: 72n,
						events: [
							{
								name: "StakeIncreased",
								staker: namedAddress("validator1-churn"),
								validator: namedAddress("validator1"),
								amount: parseSafe("1000000"),
							},
							{
								name: "StakeIncreased",
								staker: namedAddress("validator2-churn"),
								validator: namedAddress("validator2"),
								amount: parseSafe("3000000"),
							},
						],
					},
					{
						assertTimestamp: 84n,
						events: [
							{
								name: "WithdrawalInitiated",
								staker: namedAddress("validator1-churn"),
								validator: namedAddress("validator1"),
								amount: parseSafe("500000"),
							},
							{
								name: "WithdrawalInitiated",
								staker: namedAddress("validator1-exit"),
								validator: namedAddress("validator1"),
								amount: parseSafe("750000"),
							},
							{
								name: "WithdrawalInitiated",
								staker: namedAddress("validator2-churn"),
								validator: namedAddress("validator2"),
								amount: parseSafe("500000"),
							},
							{
								name: "WithdrawalInitiated",
								staker: namedAddress("validator2-exit"),
								validator: namedAddress("validator2"),
								amount: parseSafe("1500000"),
							},
						],
					},
					{
						assertTimestamp: 96n,
						events: [
							{
								name: "StakeIncreased",
								staker: namedAddress("validator1-churn"),
								validator: namedAddress("validator1"),
								amount: parseSafe("750000"),
							},
							{
								name: "StakeIncreased",
								staker: namedAddress("validator2-churn"),
								validator: namedAddress("validator2"),
								amount: parseSafe("2000000"),
							},
						],
					},
					...emptyBlocks(2, { assertTimestamp: 120n }),
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
							{ name: "KeyGenConfirmed", participant: namedAddress("validator1") },
							{ name: "KeyGenConfirmed", participant: namedAddress("validator2") },
						],
					},
					...emptyBlocks(17),
					{
						assertTimestamp: 90n,
						events: attestedTransaction({
							epoch: 1n,
							seed: "1",
							participants: ["validator1", "validator2"],
						}),
					},
					...emptyBlocks(6, { assertTimestamp: 120n }),
				],
			},
		});

		// Period [60, 120) = 60 s duration. Both validators stay registered for
		// the full period and both sign the only attested transaction, so both
		// have 100% participation.
		//
		// validator1 has 3.5M SAFE self-stake for the full period, so it meets
		// the commission threshold. Its delegate averages are:
		//   validator1-static: 1.4M for 60 s
		//                    → avg = 1.4M SAFE
		//   validator1-churn: [60,72] 0
		//                     [72,84] 1.00M
		//                     [84,96] 0.50M
		//                     [96,120] 1.25M
		//                    → avg = (0 + 12 + 6 + 30) / 60
		//                    → avg = 0.8M SAFE
		//   validator1-exit: 0.75M for [60,84], then 0
		//                    → avg = 0.75M × 24/60
		//                    → avg = 0.3M SAFE
		//   total validator1 stake
		//                    = 3.5M + 1.4M + 0.8M + 0.3M
		//                    = 6.0M SAFE
		//
		// validator2 has no self-stake at all, so it is below the 3.5M SAFE
		// commission threshold and its delegates keep their full rewards:
		//   validator2-static: 2.5M for 60 s
		//                    → avg = 2.5M SAFE
		//   validator2-churn: [60,72] 0
		//                     [72,84] 3.0M
		//                     [84,96] 2.5M
		//                     [96,120] 4.5M
		//                    → avg = (0 + 36 + 30 + 108) / 60
		//                    → avg = 2.9M SAFE
		//   validator2-exit: 1.5M for [60,84], then 0
		//                    → avg = 1.5M × 24/60
		//                    → avg = 0.6M SAFE
		//   total validator2 stake
		//                    = 2.5M + 2.9M + 0.6M
		//                    = 6.0M SAFE
		//
		// Total network stake = 12.0M SAFE, so the linear threshold T is
		// 12.0M / 2 = 6.0M SAFE. Both validators sit exactly at T, so both use
		// linear stake weighting and split 120,000 SAFE rewards equally:
		//   validator1 reward = 60,000 SAFE
		//   validator2 reward = 60,000 SAFE
		//
		// validator1 split (commission applies):
		//   staker1 self reward        = 60,000 × 3.5M / 6.0M = 35,000 SAFE
		//   validator1-static gross    = 60,000 × 1.4M / 6.0M = 14,000 SAFE
		//   validator1-churn gross     = 60,000 × 0.8M / 6.0M =  8,000 SAFE
		//   validator1-exit gross      = 60,000 × 0.3M / 6.0M =  3,000 SAFE
		//   commission                 = 5% × (14,000 + 8,000 + 3,000)
		//                              = 1,250 SAFE
		//   ---
		//   staker1 payout             = 35,000 + 1,250 = 36,250 SAFE
		//   validator1-static payout   = 14,000 - 700  = 13,300 SAFE
		//   validator1-churn payout    =  8,000 - 400  =  7,600 SAFE
		//   validator1-exit payout     =  3,000 - 150  =  2,850 SAFE
		//
		// validator2 split (no commission):
		//   validator2-static payout   = 60,000 × 2.5M / 6.0M = 25,000 SAFE
		//   validator2-churn payout    = 60,000 × 2.9M / 6.0M = 29,000 SAFE
		//   validator2-exit payout     = 60,000 × 0.6M / 6.0M =  6,000 SAFE

		const { payouts, unpaid } = await safenet.rewards(
			{ fromTimestamp: 60n, toTimestamp: 120n },
			parseSafe("120000"),
		);
		expect(payouts).toEqual({
			[namedAddress("staker1")]: parseSafe("36250"),
			[namedAddress("validator1-static")]: parseSafe("13300"),
			[namedAddress("validator1-churn")]: parseSafe("7600"),
			[namedAddress("validator1-exit")]: parseSafe("2850"),
			[namedAddress("validator2-static")]: parseSafe("25000"),
			[namedAddress("validator2-churn")]: parseSafe("29000"),
			[namedAddress("validator2-exit")]: parseSafe("6000"),
		});
		expect(unpaid).toBe(0n);
	});
});
