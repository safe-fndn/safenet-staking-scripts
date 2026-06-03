/**
 * Command to print validator statistics for a given payout period.
 */

import path from "node:path";
import { type Address, getAddress } from "viem";
import { z } from "zod";
import { Safenet } from "../safenet.js";
import { main, rewardsPeriod } from "../utils/args.js";
import { readJsonFile, writeJsonFile } from "../utils/json.js";
import { addressColumn, createPresenter, percentColumn } from "../utils/presentation.js";
import { sortByAddress } from "../utils/sort.js";

type ParticipationItem = { validator: Address; rate: number };

main(
	{
		rewardPeriodStart: z.coerce.bigint().optional(),
		rewardPeriodEnd: z.coerce.bigint().optional(),
		record: z.string().optional(),
	},
	async (args) => {
		const safenet = await Safenet.create(args);
		const period = rewardsPeriod(args);

		const { total, validators } = await safenet.participation(period);
		const presenter = createPresenter<ParticipationItem>(
			[
				addressColumn({ header: "Validator", extract: ({ validator }) => validator }),
				percentColumn({ header: "Participation", extract: ({ rate }) => rate }),
			],
			args,
		);
		for (const [validator, count] of Object.entries(validators)) {
			presenter.writeRow({ validator: getAddress(validator), rate: count / total });
		}
		presenter.finish();

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
