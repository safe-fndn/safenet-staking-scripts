/**
 * Command to print validator statistics for a given payout period.
 */

import { z } from "zod";
import { Safenet } from "../safenet.js";
import { main, rewardsPeriod } from "./args.js";

main(
	{
		rewardPeriodStart: z.bigint().optional(),
		rewardPeriodEnd: z.bigint().optional(),
	},
	async (args) => {
		const safenet = await Safenet.create(args);
		const period = rewardsPeriod(args);
		console.log(period);
		await safenet.validatorStats(period);
	},
);
