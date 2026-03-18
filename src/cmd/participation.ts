/**
 * Command to print validator statistics for a given payout period.
 */

import path from "node:path";
import { getAddress } from "viem";
import { z } from "zod";
import { Safenet } from "../safenet.js";
import { main, rewardsPeriod } from "../utils/args.js";
import { formatPercent } from "../utils/format.js";
import { readJsonFile, writeJsonFile } from "../utils/json.js";
import { sortByAddress } from "../utils/sort.js";

main(
	{
		rewardPeriodStart: z.coerce.bigint().optional(),
		rewardPeriodEnd: z.coerce.bigint().optional(),
		approximate: z.coerce.boolean().optional(),
		record: z.string().optional(),
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

		if (args.record !== undefined) {
			const validatorsFile = path.join(args.record, "assets", "validator-info.json");
			const data = await readJsonFile(
				validatorsFile,
				z
					.looseObject({
						address: z.string().transform((s) => getAddress(s)),
						participation_rate_14d: z.number(),
					})
					.array(),
			);

			for (const [validator, count] of Object.entries(validators)) {
				const participationRate = count / total;
				const info = data.find(({ address }) => address === validator);
				if (info !== undefined) {
					info.participation_rate_14d = participationRate;
				} else {
					data.push({
						address: getAddress(validator),
						participation_rate_14d: participationRate,
					});
				}
			}

			sortByAddress(data, (info) => info.address);
			await writeJsonFile(validatorsFile, data);
		}
	},
);
