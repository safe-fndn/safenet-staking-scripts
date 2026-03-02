/**
 * A general purpose event indexer.
 *
 * This stores events into a SQLite database in order to cache log queries
 * instead of always fetching them from the node.
 */

import type { Database, Statement, Transaction } from "better-sqlite3";
import debug, { type Debugger } from "debug";
import {
	type AbiEvent,
	type Address,
	type Client,
	type ExtractAbiItem,
	getAbiItem,
	type Log,
	toEventSelector,
} from "viem";
import { getBlockNumber, getLogs, readContract } from "viem/actions";
import { z } from "zod";
import { CONSENSUS_ABI, COORDINATOR_ABI, STAKING_ABI } from "./abi.js";
import { jsonPreprocessor, jsonReplacer } from "./utils/json.js";
import { type BlockRange, nextPage, type PagedBlockRange, reduceRanges } from "./utils/ranges.js";

export type Configuration<Event> = {
	db: Database;
	client: Client;
	address: Address;
	event: Event;
	startBlock?: bigint;
	backoff?: number[];
};

const bigIntIshSchema = z.union([z.bigint(), z.int(), z.string()]).transform((i) => BigInt(i));
const rangesSchema = z.preprocess(
	jsonPreprocessor,
	z
		.object({
			fromBlock: bigIntIshSchema,
			toBlock: bigIntIshSchema,
		})
		.array(),
);

type ParsedLog<Event extends AbiEvent> = Log<bigint, number, false, Event, true>;

export type UpdateBlockRange = Partial<BlockRange> & Pick<PagedBlockRange, "blockPageSize">;

export class Indexer<Event extends AbiEvent> {
	#debug: Debugger;
	#db: Database;
	#client: Client;
	#filter: {
		address: Address;
		event: Event;
		strict: true;
	};
	#startBlock?: bigint;
	#backoff: number[];
	#table: string;
	#queries: {
		selectIndexedRanges: Statement<[], string>;
		upsertIndexedRanges: Statement<{ ranges: string }, number>;
		insertEvent: Statement<{ blockNumber: bigint; logIndex: number; args: string }, number>;
		addEvents: Transaction<(args: { page: BlockRange; logs: ParsedLog<Event>[] }) => void>;
	};

	constructor({ db, client, address, event, startBlock, backoff }: Configuration<Event>) {
		this.#debug = debug(`indexer:${event.name}`);
		this.#db = db;
		this.#client = client;
		this.#filter = {
			address,
			event,
			strict: true,
		};
		this.#startBlock = startBlock;
		this.#backoff = backoff ?? [200, 1000, 5000];

		// We create a unique table per address and event. This ensures that we
		// don't accidentally mix up events with different signatures accross
		// or different contracts.
		this.#table = `indexer_${address}_${toEventSelector(event)}`;

		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS indexer_ranges(
				table_name TEXT NOT NULL,
				ranges TEXT NOT NULL,
				PRIMARY KEY(table_name)
			);

			CREATE TABLE IF NOT EXISTS ${this.#table}(
				block_number INTEGER NOT NULL,
				log_index INTEGER NOT NULL,
				args TEXT NOT NULL,
				PRIMARY KEY(block_number, log_index)
			);
		`);

		this.#queries = {
			selectIndexedRanges: this.#db.prepare<[], string>(`
				SELECT ranges
				FROM indexer_ranges
				WHERE table_name = '${this.#table}'
			`),
			upsertIndexedRanges: this.#db.prepare<{ ranges: string }, number>(`
				INSERT INTO indexer_ranges(table_name, ranges)
				VALUES('${this.#table}', @ranges)
				ON CONFLICT(table_name)
				DO UPDATE SET ranges = excluded.ranges
			`),
			insertEvent: this.#db.prepare<
				{ blockNumber: bigint; logIndex: number; args: string },
				number
			>(`
				INSERT INTO ${this.#table}(block_number, log_index, args)
				VALUES(@blockNumber, @logIndex, @args)
				ON CONFLICT(block_number, log_index)
				DO NOTHING
			`),
			addEvents: this.#db.transaction(
				({ page, logs }: { page: BlockRange; logs: ParsedLog<Event>[] }) => {
					// Update atomically, preventing any undefined behaviour in
					// case we are running multiple indexers for the same event.
					const ranges = reduceRanges([page, ...this.#indexedRanges()]);
					this.#queries.upsertIndexedRanges.run({ ranges: JSON.stringify(ranges, jsonReplacer) });
					for (const { blockNumber, logIndex, args } of logs) {
						this.#queries.insertEvent.run({
							blockNumber,
							logIndex,
							args: JSON.stringify(args, jsonReplacer),
						});
					}
				},
			),
		};
	}

	#indexedRanges(): BlockRange[] {
		return rangesSchema.safeParse(this.#queries.selectIndexedRanges.pluck().get()).data ?? [];
	}

	#nextPage(range: PagedBlockRange): BlockRange | null {
		return nextPage(range, this.#indexedRanges());
	}

	async #getLogs(page: BlockRange): Promise<ParsedLog<Event>[]> {
		const params = {
			...this.#filter,
			...page,
		} as const;

		for (const backoff of this.#backoff) {
			try {
				return await getLogs(this.#client, params);
			} catch (err) {
				const msg = err instanceof Error ? err.message : "unknown error";
				this.#debug(`error fetching logs (${msg}), trying again in ${backoff / 1000}s`);
				await new Promise((resolve) => setTimeout(resolve, backoff));
			}
		}
		return await getLogs(this.#client, params);
	}

	async update(
		{ fromBlock, toBlock, blockPageSize }: UpdateBlockRange,
		cancel?: () => boolean,
	): Promise<void> {
		const range = {
			fromBlock: fromBlock ?? this.#startBlock ?? 0n,
			toBlock: toBlock ?? (await getBlockNumber(this.#client)),
			blockPageSize,
		};
		while (cancel?.() !== true) {
			const page = this.#nextPage(range);
			if (page === null) {
				break;
			}
			this.#debug(`fetching block page ${page.fromBlock}-${page.toBlock}`);

			const logs = await this.#getLogs(page);
			this.#queries.addEvents({ page, logs });
			this.#debug(`indexed ${logs.length} logs`);
		}
	}
}

export type SafenetIndexers = {
	stakeIncreased: Indexer<ExtractAbiItem<typeof STAKING_ABI, "StakeIncreased">>;
	withdrawalInitiated: Indexer<ExtractAbiItem<typeof STAKING_ABI, "WithdrawalInitiated">>;
	validatorUpdated: Indexer<ExtractAbiItem<typeof STAKING_ABI, "ValidatorUpdated">>;
	signShared: Indexer<ExtractAbiItem<typeof COORDINATOR_ABI, "SignShared">>;
	signCompleted: Indexer<ExtractAbiItem<typeof COORDINATOR_ABI, "SignCompleted">>;
	validatorStakerSet: Indexer<ExtractAbiItem<typeof CONSENSUS_ABI, "ValidatorStakerSet">>;
	transactionAttested: Indexer<ExtractAbiItem<typeof CONSENSUS_ABI, "TransactionAttested">>;
};

export const createSafenetIndexers = async ({
	db,
	...params
}: {
	db: Database;
	stakingClient: Client;
	stakingAddress: Address;
	stakingStartBlock?: bigint;
	consensusClient: Client;
	consensusAddress: Address;
	consensusStartBlock?: bigint;
}): Promise<SafenetIndexers> => {
	const coordinatorAddress = await readContract(params.consensusClient, {
		address: params.consensusAddress,
		abi: CONSENSUS_ABI,
		functionName: "COORDINATOR",
	});

	return {
		stakeIncreased: new Indexer({
			db,
			client: params.stakingClient,
			address: params.stakingAddress,
			event: getAbiItem({ abi: STAKING_ABI, name: "StakeIncreased" }),
			startBlock: params.stakingStartBlock,
		}),
		withdrawalInitiated: new Indexer({
			db,
			client: params.stakingClient,
			address: params.stakingAddress,
			event: getAbiItem({ abi: STAKING_ABI, name: "WithdrawalInitiated" }),
			startBlock: params.stakingStartBlock,
		}),
		validatorUpdated: new Indexer({
			db,
			client: params.stakingClient,
			address: params.stakingAddress,
			event: getAbiItem({ abi: STAKING_ABI, name: "ValidatorUpdated" }),
			startBlock: params.stakingStartBlock,
		}),
		signShared: new Indexer({
			db,
			client: params.consensusClient,
			address: coordinatorAddress,
			event: getAbiItem({ abi: COORDINATOR_ABI, name: "SignShared" }),
			startBlock: params.consensusStartBlock,
		}),
		signCompleted: new Indexer({
			db,
			client: params.consensusClient,
			address: coordinatorAddress,
			event: getAbiItem({ abi: COORDINATOR_ABI, name: "SignCompleted" }),
			startBlock: params.consensusStartBlock,
		}),
		validatorStakerSet: new Indexer({
			db,
			client: params.consensusClient,
			address: params.consensusAddress,
			event: getAbiItem({ abi: CONSENSUS_ABI, name: "ValidatorStakerSet" }),
			startBlock: params.consensusStartBlock,
		}),
		transactionAttested: new Indexer({
			db,
			client: params.consensusClient,
			address: params.consensusAddress,
			event: getAbiItem({ abi: CONSENSUS_ABI, name: "TransactionAttested" }),
			startBlock: params.consensusStartBlock,
		}),
	};
};

export const updateIndexers = async (
	indexers: Partial<SafenetIndexers>,
	range: UpdateBlockRange,
): Promise<void> => {
	// We want to fail updating early - that is if we run into trouble with a
	// particular indexer, we want to stop the others. This prevents large block
	// ranges that take a long time to index hide early errors.
	let failedEarly = false;
	await Promise.all(
		Object.values(indexers).map((indexer) =>
			indexer
				.update(range, () => failedEarly)
				.catch((err) => {
					failedEarly = true;
					throw err;
				}),
		),
	);
};
