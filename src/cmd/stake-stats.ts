/**
 * Command to print stake statistics for a given payout period.
 */

import { formatUnits } from "viem";
import { z } from "zod";
import { Safenet } from "../safenet.js";
import { main, rewardsPeriod } from "./args.js";

const formatSafe = (amount: bigint): string => {
	const formatted = formatUnits(amount, 18);
	const [int, frac] = formatted.split(".");

	// We pad the integer parts to account for the 1.000.000.000 total supply of
	// SAFE, and the fractional part for 18 decimal places.
	return `${int.padStart(10)}.${(frac ?? "0").padEnd(18)}`;
};

main(
	{
		rewardPeriodStart: z.bigint().optional(),
		rewardPeriodEnd: z.bigint().optional(),
	},
	async (args) => {
		const safenet = await Safenet.create(args);
		const period = rewardsPeriod(args);

		console.log(
			` Staker                                     | Validator                                  | Average Stake`,
		);
		console.log(
			`--------------------------------------------+--------------------------------------------+-------------------------------`,
		);
		for await (const { staker, validator, amount } of safenet.staked(period)) {
			console.log(` ${staker} | ${validator} | ${formatSafe(amount)}`);
		}
	},
);
