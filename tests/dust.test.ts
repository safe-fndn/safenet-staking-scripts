import { describe, expect, it } from "vitest";
import { attestedTransaction } from "./harness/presets.js";
import { createTestSafenet } from "./harness/scenario.js";
import { emptyBlocks, namedAddress, parseSafe } from "./harness/utils.js";

describe("dust", () => {
	it("carries forward sub-1 SAFE delegate payouts as unpaid", async () => {
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
								staker: namedAddress("delegate"),
								validator: namedAddress("validator"),
								amount: parseSafe("999999"),
							},
							{
								name: "StakeIncreased",
								staker: namedAddress("dust"),
								validator: namedAddress("validator"),
								amount: parseSafe("1"),
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
								staker: namedAddress("operator"),
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
						events: attestedTransaction({
							epoch: 1n,
							seed: "1",
							participants: ["validator"],
						}),
					},
					...emptyBlocks(12, { assertTimestamp: 120n }),
				],
			},
		});

		// One validator at 100% participation receives the full 500,000 SAFE.
		// There is no self-stake because the validator staker ("operator") has no
		// stake deposited, so rewards are split purely across delegated stake:
		//
		//   delegate reward = 500,000 * 999,999 / 1,000,000
		//                   = 499,999.5 SAFE
		//   dust reward     = 500,000 * 1 / 1,000,000
		//                   = 0.5 SAFE
		//
		// The dust payout is below the 1 SAFE minimum, so it is omitted and
		// carried forward as unpaid.

		const { payouts, unpaid } = await safenet.rewards(
			{ fromTimestamp: 60n, toTimestamp: 120n },
			parseSafe("500000"),
		);
		expect(payouts).toEqual({
			[namedAddress("delegate")]: parseSafe("499999.5"),
		});
		expect(unpaid).toBe(parseSafe("0.5"));
	});
});
