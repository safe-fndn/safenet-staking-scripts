/**
 * Command to print stake statistics for a given payout period.
 */

import { z } from "zod";
import { Safenet } from "../safenet.js";
import { main, rewardsPeriod } from "../utils/args.js";
import { formatSafeToken } from "../utils/format.js";

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
		for await (const { staker, amounts } of safenet.staked(period)) {
			for (const { validator, amount } of amounts) {
				console.log(` ${staker} | ${validator} | ${formatSafeToken(amount)}`);
			}
		}
	},
);
