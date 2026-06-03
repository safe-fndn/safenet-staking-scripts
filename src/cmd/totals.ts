/**
 * Command to print current network totals.
 */

import path from "node:path";
import { z } from "zod";
import { Safenet } from "../safenet.js";
import { main } from "../utils/args.js";
import { formatSafeToken } from "../utils/format.js";
import { writeJsonFile } from "../utils/json.js";
import { createPresenter, safeTokenColumn } from "../utils/presentation.js";

type TotalsItem = { stake: bigint; transactions: number };

main(
	{
		record: z.string().optional(),
	},
	async (args) => {
		const safenet = await Safenet.create(args);

		const { stake, transactions } = await safenet.totals();
		const presenter = createPresenter<TotalsItem>(
			[
				safeTokenColumn({ header: "Total Stake", extract: ({ stake }) => stake }),
				{
					header: "Transactions",
					width: 12,
					align: "right",
					format: ({ transactions }) => transactions.toString(),
				},
			],
			args,
		);
		presenter.writeRow({ stake, transactions });
		presenter.finish();

		if (args.record !== undefined) {
			const networksFile = path.join(args.record, "assets", "network-info.json");
			await writeJsonFile(networksFile, {
				total_staked_amount: formatSafeToken(stake).trim(),
				total_transactions_checked: transactions,
			});
		}
	},
);
