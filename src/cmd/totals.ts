/**
 * Command to print current network totals.
 */

import path from "node:path";
import { z } from "zod";
import { Safenet } from "../safenet.js";
import { main } from "../utils/args.js";
import { formatSafeToken } from "../utils/format.js";
import { writeJsonFile } from "../utils/json.js";

main(
	{
		record: z.string().optional(),
	},
	async (args) => {
		const safenet = await Safenet.create(args);

		console.log(` Total Stake                   | Transactions         `);
		console.log(`-------------------------------+----------------------`);
		const { stake, transactions } = await safenet.totals();
		console.log(` ${formatSafeToken(stake)} | ${transactions.toString().padStart(20)}`);

		if (args.record !== undefined) {
			const networksFile = path.join(args.record, "assets", "network-info.json");
			await writeJsonFile(networksFile, {
				total_staked_amount: formatSafeToken(stake).trim(),
				total_transactions_checked: transactions,
			});
		}
	},
);
