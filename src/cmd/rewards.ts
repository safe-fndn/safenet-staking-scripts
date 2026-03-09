/**
 * Command to print reward payouts for a given payout period.
 */

import { parseUnits } from "viem";
import { z } from "zod";
import { Safenet } from "../safenet.js";
import { main, rewardsPeriod } from "../utils/args.js";
import { formatSafeToken } from "../utils/format.js";

main(
	{
		rewardPeriodStart: z.coerce.bigint().optional(),
		rewardPeriodEnd: z.coerce.bigint().optional(),
		totalRewards: z.string().transform((v) => parseUnits(v, 18)),
		approximate: z.coerce.boolean().optional(),
	},
	async (args) => {
		const safenet = await Safenet.create(args);
		const period = rewardsPeriod(args);

		const { payouts, unpaid } = await safenet.rewards(period, args.totalRewards, args);

		console.log(` Recipient                                  | Payout                        `);
		console.log(`--------------------------------------------+-------------------------------`);
		for (const [recipient, amount] of Object.entries(payouts)) {
			console.log(` ${recipient} | ${formatSafeToken(amount)}`);
		}
		console.log(`--------------------------------------------+-------------------------------`);
		console.log(` ${"Unpaid (carried forward)".padEnd(42)} | ${formatSafeToken(unpaid)}`);
	},
);
