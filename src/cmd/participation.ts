/**
 * Command to print validator statistics for a given payout period.
 */

import { z } from "zod";
import { Safenet } from "../safenet.js";
import { main, rewardsPeriod } from "../utils/args.js";
import { formatPercent } from "../utils/format.js";

main(
	{
		rewardPeriodStart: z.coerce.bigint().optional(),
		rewardPeriodEnd: z.coerce.bigint().optional(),
		approximate: z.coerce.boolean().optional(),
	},
	async (args) => {
		const safenet = await Safenet.create(args);
		const period = rewardsPeriod(args);

		console.log(` Validator                                  | Participation`);
		console.log(`--------------------------------------------+---------------`);
		const { total, validators } = await safenet.participation(period, args);
		for (const [validator, count] of Object.entries(validators)) {
			console.log(` ${validator} | ${formatPercent(count / total).padStart(13)}`);
		}
	},
);
