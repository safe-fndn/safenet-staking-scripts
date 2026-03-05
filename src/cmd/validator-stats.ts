/**
 * Command to print validator statistics for a given payout period.
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

		console.log(` Validator                                  | Self Stake                    `);
		console.log(`--------------------------------------------+-------------------------------`);
		const validators = await safenet.validatorStats(period);
		for (const [validator, { stake }] of Object.entries(validators)) {
			console.log(` ${validator} | ${formatSafeToken(stake)}`);
		}
	},
);
