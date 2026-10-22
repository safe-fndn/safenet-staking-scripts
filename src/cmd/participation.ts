/**
 * Command to print validator and sentinel participation for a given payout period.
 */

import path from "node:path";
import { type Address, getAddress } from "viem";
import { z } from "zod";
import { type Participation, Safenet, type SentinelParticipation } from "../safenet.js";
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

/**
 * Computes a participation rate. A period without any on-chain activity has a
 * `total` of zero, in which case every participant took part in all (none) of
 * the requests, so the rate is defined to be one instead of the `NaN` that
 * would otherwise end up serialized as `null` in JSON output.
 */
const participationRate = (count: number, total: number): number =>
	total === 0 ? 1 : count / total;

/**
 * Updates the `participation_rate_14d` of each participant in an
 * `assets/*-info.json` file of the record directory, adding entries for
 * participants that are not yet listed. Rates may be `null` in the file (for
 * example for participants that have not been measured yet), so the read schema
 * accepts it. All other fields are preserved as is. New entries get an empty
 * `label`, so that consumers of the generated files can rely on it being set.
 */
async function recordParticipation(
	file: string,
	counts: Record<string, number>,
	total: number,
): Promise<void> {
	const data = await readJsonFile(
		file,
		z
			.looseObject({
				address: z.string().transform((s) => getAddress(s)),
				participation_rate_14d: z.number().nullable().optional(),
			})
			.array(),
	);

	for (const [participant, count] of Object.entries(counts)) {
		const address = getAddress(participant);
		const rate = participationRate(count, total);
		const info = data.find((info) => info.address === address);
		if (info !== undefined) {
			info.participation_rate_14d = rate;
		} else {
			data.push({ address, label: "", participation_rate_14d: rate });
		}
	}

	sortByAddress(data, (info) => info.address);
	await writeJsonFile(file, data);
}

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
		let sentinelParticipation: SentinelParticipation | null = null;

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
						rate: participationRate(count, total),
					})),
					({ participant }) => participant,
				),
			);
		}
		if (args.category !== "validator") {
			// Sentinels only appear once they have revealed at least once, so
			// `total` is never zero for a non-empty `sentinels` map.
			sentinelParticipation = await safenet.sentinelParticipation(period);
			const { total, sentinels } = sentinelParticipation;
			rows.push(
				...sortByAddress(
					Object.entries(sentinels).map(([sentinel, count]) => ({
						category: "Sentinel" as const,
						participant: getAddress(sentinel),
						rate: participationRate(count, total),
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
			const assets = path.join(args.record, "assets");
			const { total, validators } = validatorParticipation ?? (await safenet.participation(period));
			await recordParticipation(path.join(assets, "validator-info.json"), validators, total);
			const sentinels = sentinelParticipation ?? (await safenet.sentinelParticipation(period));
			await recordParticipation(
				path.join(assets, "sentinel-info.json"),
				sentinels.sentinels,
				sentinels.total,
			);
		}
	},
);
