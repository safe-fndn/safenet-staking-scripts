/**
 * Command to print validator statistics for a given payout period.
 */

import path from "node:path";
import { type Address, getAddress } from "viem";
import { z } from "zod";
import { type Participation, Safenet } from "../safenet.js";
import { main, rewardsPeriod } from "../utils/args.js";
import { readJsonFile, writeJsonFile } from "../utils/json.js";
import {
	addressColumn,
	type ColumnDef,
	createPresenter,
	percentColumn,
} from "../utils/presentation.js";
import { sortByAddress } from "../utils/sort.js";

type Category = "Validator" | "Sentinel";
type ParticipationItem = { category: Category; participant: Address; rate: number };

/**
 * Column for the participation category. Kept local to this command, as it is
 * not (yet) general enough to warrant a helper in `../utils/presentation.js`.
 */
const categoryColumn: ColumnDef<ParticipationItem> = {
	header: "Category",
	width: Math.max("Category".length, "Validator".length, "Sentinel".length),
	format: ({ category }) => category,
};

main(
	{
		rewardPeriodStart: z.coerce.bigint().optional(),
		rewardPeriodEnd: z.coerce.bigint().optional(),
		category: z.enum(["validator", "sentinel", "all"]).default("all"),
		record: z.string().optional(),
	},
	async (args) => {
		const safenet = await Safenet.create(args);
		const period = rewardsPeriod(args);

		// Kept around so that `--record` below can reuse it instead of querying
		// a second time.
		let validatorParticipation: Participation | null = null;

		// Rows are grouped by category and sorted by address within each group,
		// so that the output is stable across runs. Participation is only
		// queried for the categories that are actually printed, and the queries
		// are never awaited concurrently, as the indexers are not safe to run
		// against themselves in parallel.
		const rows: ParticipationItem[] = [];
		if (args.category !== "sentinel") {
			validatorParticipation = await safenet.participation(period);
			const { total, validators } = validatorParticipation;
			rows.push(
				...sortByAddress(
					Object.entries(validators).map(([validator, count]) => ({
						category: "Validator" as const,
						participant: getAddress(validator),
						rate: count / total,
					})),
					({ participant }) => participant,
				),
			);
		}
		if (args.category !== "validator") {
			// Sentinels only appear once they have revealed at least once, so
			// `total` is never zero for a non-empty `sentinels` map.
			const { total, sentinels } = await safenet.sentinelParticipation(period);
			rows.push(
				...sortByAddress(
					Object.entries(sentinels).map(([sentinel, count]) => ({
						category: "Sentinel" as const,
						participant: getAddress(sentinel),
						rate: count / total,
					})),
					({ participant }) => participant,
				),
			);
		}

		const presenter = createPresenter<ParticipationItem>(
			[
				categoryColumn,
				addressColumn({ header: "Participant", extract: ({ participant }) => participant }),
				percentColumn({ header: "Participation", extract: ({ rate }) => rate }),
			],
			args,
		);
		for (const row of rows) {
			presenter.writeRow(row);
		}
		presenter.finish();

		if (args.record !== undefined) {
			const { total, validators } = validatorParticipation ?? (await safenet.participation(period));
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
