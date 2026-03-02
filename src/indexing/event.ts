/**
 * A general purpose event indexer.
 *
 * This stores events into a SQLite database in order to cache log queries
 * instead of always fetching them from the node.
 */

import type { Database, Statement, Transaction } from "better-sqlite3";
import debug, { type Debugger } from "debug";
import { type AbiEvent, type Address, type Client, type Log, toEventSelector } from "viem";
import { getBlockNumber, getLogs } from "viem/actions";
import { type Backoff, backoff } from "../utils/backoff.js";
import { jsonReplacer } from "../utils/json.js";
import { minBigInt } from "../utils/math.js";
import type { BlockTimestampCache } from "./block.js";

export type Configuration<Event> = {
	db: Database;
	client: Client;
	chainId: number;
	address: Address;
	event: Event;
	startBlock?: bigint;
	blocks?: BlockTimestampCache;
};

export type UpdateBlockRange = {
	toBlock?: bigint;
	blockPageSize: bigint;
};

type ParsedLog<Event extends AbiEvent> = Log<bigint, number, false, Event, true>;

type BlockRange = {
	fromBlock: bigint;
	toBlock: bigint;
};

export class EventIndexer<Event extends AbiEvent> {
	#debug: Debugger;
	#db: Database;
	#client: Client;
	#filter: {
		address: Address;
		event: Event;
		strict: true;
	};
	#backoff: Backoff;
	#blocks?: BlockTimestampCache;
	#table: string;
	#queries: {
		selectUpdate: Statement<[], number>;
		upsertUpdate: Statement<{ toBlock: bigint }, number>;
		insertEvent: Statement<{ blockNumber: bigint; logIndex: number; args: string }, number>;
		addEvents: Transaction<(args: { page: BlockRange; logs: ParsedLog<Event>[] }) => void>;
	};

	constructor({ db, client, chainId, address, event, startBlock, blocks }: Configuration<Event>) {
		this.#debug = debug(`indexing:event:${event.name}`);
		this.#db = db;
		this.#client = client;
		this.#filter = {
			address,
			event,
			strict: true,
		};
		this.#backoff = backoff({
			debug: this.#debug,
		});
		this.#blocks = blocks;

		// We create a unique table per contract and event. This ensures that we
		// don't accidentally mix up events.
		this.#table = `event_${event.name}_${chainId}_${address}_${toEventSelector(event)}`;

		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS event_updates(
				table_name TEXT NOT NULL,
				to_block INTEGER NOT NULL,
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
			selectUpdate: this.#db.prepare<[], number>(`
				SELECT to_block
				FROM event_updates
				WHERE table_name = '${this.#table}'
			`),
			upsertUpdate: this.#db.prepare<{ toBlock: bigint }, number>(`
				INSERT INTO event_updates(table_name, to_block)
				VALUES('${this.#table}', @toBlock)
				ON CONFLICT(table_name)
				DO UPDATE SET to_block = excluded.to_block
				WHERE excluded.to_block > event_updates.to_block
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
					this.#queries.upsertUpdate.run(page);
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

		// If we have a starting block specified, then we can mark that we have
		// effectively indexed all events prior to that block.
		if (startBlock) {
			this.#queries.upsertUpdate.run({ toBlock: startBlock - 1n });
		}
	}

	get table(): string {
		return this.#table;
	}

	#nextPage(range: Required<UpdateBlockRange>): BlockRange | null {
		const lastToBlock = BigInt(this.#queries.selectUpdate.pluck().get() ?? -1);
		if (lastToBlock >= range.toBlock) {
			return null;
		}

		const fromBlock = lastToBlock + 1n;
		const toBlock = minBigInt(fromBlock + range.blockPageSize - 1n, range.toBlock);
		return { fromBlock, toBlock };
	}

	async update(
		{ toBlock, blockPageSize }: UpdateBlockRange,
		cancel?: () => boolean,
	): Promise<void> {
		const range = {
			toBlock: toBlock ?? (await getBlockNumber(this.#client)),
			blockPageSize,
		};
		while (cancel?.() !== true) {
			const page = this.#nextPage(range);
			if (page === null) {
				break;
			}
			this.#debug(`fetching block page ${page.fromBlock}-${page.toBlock}`);

			const logs = await this.#backoff(() =>
				getLogs(this.#client, {
					...this.#filter,
					...page,
				}),
			);

			// Some RPC nodes return events with block timestamps that we can
			// record directly in our block timestamp cache. Record them for
			// each log where possible.
			if (this.#blocks !== undefined) {
				for (const log of logs) {
					if (!this.#blocks.recordLog(log)) {
						// The log wasn't recorded because the node does not
						// include block timestamps with logs, no point in
						// keeping on going - all logs will be this way.
						break;
					}
				}
			}

			this.#queries.addEvents({ page, logs });
			this.#debug(`indexed ${logs.length} logs`);
		}
	}
}
