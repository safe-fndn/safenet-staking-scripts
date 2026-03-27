/**
 * A general purpose event indexer.
 *
 * This is implemented as an abstract class where events are queried from a
 * node, and the implementation is responsible for processing and storing the
 * data; managing only the indexing status and progress.
 */

import type { Database, Statement, Transaction } from "better-sqlite3";
import debug, { type Debugger } from "debug";
import { type AbiEvent, type Address, type Client, getAddress, type Log } from "viem";
import { getBlockNumber, getLogs } from "viem/actions";
import { type Backoff, backoff } from "../utils/backoff.js";
import { formatRange } from "../utils/format.js";
import { minBigInt } from "../utils/math.js";
import type { BlockRange, ToBlock, ToTimestamp } from "../utils/ranges.js";
import type { BlockTimestampCache } from "./block.js";

export type Configuration = {
	db: Database;
	blocks: BlockTimestampCache;
	client: Client;
	blockPageSize: bigint;
	chainId: number;
	address: Address;
	startBlock?: bigint;
};

export type Parameters<Events> = {
	name: string;
	events: Events;
} & Configuration;

export type UpdateBlockRange = {
	toBlock?: BlockRange["toBlock"];
	blockPageSize: bigint;
};

export type ParsedLog<Events extends AbiEvent[]> = Log<
	bigint,
	number,
	false,
	undefined,
	true,
	Events
>;

export abstract class EventIndexer<Events extends AbiEvent[] = []> {
	#debug: Debugger;
	#blocks: BlockTimestampCache;
	#client: Client;
	#blockPageSize: bigint;
	#filter: {
		address: Address;
		events: Events;
		strict: true;
	};
	#backoff: Backoff;
	#db: Database;
	#queries: {
		selectIndexer: Statement<[], number>;
		updateIndexer: Statement<{ toBlock: bigint }, number>;
		addEvents: Transaction<(args: { page: BlockRange; logs: ParsedLog<Events>[] }) => void>;
	};

	protected constructor({
		name,
		events,
		db,
		blocks,
		client,
		blockPageSize,
		chainId,
		address,
		startBlock,
	}: Parameters<Events>) {
		this.#debug = debug(`safenet:indexing:${name}`);
		//this.#selector = `${name}/`;
		this.#blocks = blocks;
		this.#client = client;
		this.#filter = {
			address,
			events,
			strict: true,
		};
		this.#blockPageSize = blockPageSize;
		this.#backoff = backoff({
			debug: this.#debug,
		});

		this.#db = db;
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS event_indexers(
				name TEXT NOT NULL,
				contract TEXT NOT NULL,
				to_block INTEGER NOT NULL,
				PRIMARY KEY(name)
			) WITHOUT ROWID;
		`);

		// Initialize the indexer based on the starting block. We also detect
		// if the indexer was created with a different "identifier" to prevent
		// issues where the same configuration is used for indexing multiple
		// Safenet instances (which would corrupt our data).
		const contract = `${chainId}:${getAddress(address)}`;
		const insert = this.#db
			.prepare(`
				INSERT INTO event_indexers(name, contract, to_block)
				VALUES ('${name}', '${contract}', @toBlock)
				ON CONFLICT(name)
				DO UPDATE SET to_block = MAX(to_block, EXCLUDED.to_block)
				WHERE contract = '${contract}'
			`)
			.run({ toBlock: (startBlock ?? 0n) - 1n });
		if (insert.changes === 0) {
			throw new Error("event indexer connected to the wrong database");
		}

		this.#queries = {
			selectIndexer: this.#db.prepare<[], number>(`
				SELECT to_block
				FROM event_indexers
				WHERE name = '${name}'
			`),
			updateIndexer: this.#db.prepare<{ toBlock: bigint }, number>(`
				UPDATE event_indexers
				SET to_block = @toBlock
				WHERE name = '${name}'
			`),
			addEvents: this.#db.transaction(
				({ page, logs }: { page: BlockRange; logs: ParsedLog<Events>[] }) => {
					this.#queries.updateIndexer.run(page);
					for (const log of logs) {
						this.insertEvent(log);

						// Some RPC nodes return events with block timestamps
						// that we can record directly in our block timestamp
						// cache, which saves us an RPC request later.
						this.#blocks.recordLog(log);
					}
				},
			),
		};
	}

	protected get db(): Database {
		return this.#db;
	}

	protected get blocks(): BlockTimestampCache {
		return this.#blocks;
	}

	#nextPage(range: ToBlock): BlockRange | null {
		const latest = this.latestBlock() ?? -1n;
		if (latest >= range.toBlock) {
			return null;
		}

		const fromBlock = latest + 1n;
		const toBlock = minBigInt(fromBlock + this.#blockPageSize - 1n, range.toBlock);
		return { fromBlock, toBlock };
	}

	latestBlock(): bigint | null {
		const latest = this.#queries.selectIndexer.pluck().get();
		return latest !== undefined ? BigInt(latest) : null;
	}

	async update({ toTimestamp }: Partial<ToTimestamp> = {}, cancel?: () => boolean): Promise<void> {
		const range = {
			toBlock:
				toTimestamp !== undefined
					? await this.#blocks.blockBefore({ timestamp: toTimestamp })
					: await getBlockNumber(this.#client),
		};
		let startBlock: bigint | null = null;
		while (cancel?.() !== true) {
			const page = this.#nextPage(range);
			if (page === null) {
				break;
			}

			startBlock = startBlock ?? page.fromBlock;
			const progress =
				(100 * Number(page.toBlock - startBlock)) / Number(range.toBlock - startBlock);
			this.#debug(`fetching block page ${formatRange(page)} (${progress.toFixed(2)}%)`);

			const logs = await this.#backoff(() =>
				getLogs(this.#client, {
					...this.#filter,
					...page,
				}),
			);

			this.#queries.addEvents({ page, logs });
			this.#debug(`indexed ${logs.length} logs`);
		}
	}

	protected abstract insertEvent(log: ParsedLog<Events>): void;
}
