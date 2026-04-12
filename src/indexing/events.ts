/**
 * A general purpose event indexer.
 *
 * This is implemented as an abstract class where events are queried from a
 * node, and the implementation is responsible for processing and storing the
 * data; managing only the indexing status and progress.
 */

import type { Database, Statement, Transaction } from "better-sqlite3";
import debug, { type Debugger } from "debug";
import {
	type AbiEvent,
	type Address,
	type Client,
	getAddress,
	type UnionPick,
	type Log as ViemLog,
} from "viem";
import { getBlock, getLogs } from "viem/actions";
import { type Backoff, backoff } from "../utils/backoff.js";
import { formatRange } from "../utils/format.js";
import { minBigInt } from "../utils/math.js";
import type { BlockRange, FromBlock, ToTimestamp } from "../utils/ranges.js";

export type Configuration<Data extends { db: Database }> = {
	data: Data;
	client: Client;
	blockPageSize: bigint;
	chainId: number;
	address: Address;
	startBlock?: bigint;
};

export type Parameters<Events, Data extends { db: Database }> = {
	name: string;
	events: Events;
} & Configuration<Data>;

type ParsedLog<Events extends AbiEvent[]> = ViemLog<bigint, number, false, undefined, true, Events>;
export type Log<Events extends AbiEvent[]> = UnionPick<ParsedLog<Events>, "eventName" | "args"> & {
	blockTimestamp: bigint;
};

export type BlockTimestamp<I = bigint> = {
	number: I;
	timestamp: I;
};

type BlockPage = BlockRange & ToTimestamp;

export abstract class EventIndexer<
	Events extends AbiEvent[] = [],
	Data extends { db: Database } = { db: Database },
> {
	#debug: Debugger;
	#contract: string;
	#client: Client;
	#blockPageSize: bigint;
	#filter: {
		address: Address;
		events: Events;
		strict: true;
	};
	#backoff: Backoff;
	#data: Data;
	#queries: {
		selectIndexer: Statement<[], BlockTimestamp<number>>;
		updateIndexer: Statement<BlockTimestamp<bigint>, number>;
		addEvents: Transaction<(args: { block: BlockTimestamp; logs: Log<Events>[] }) => void>;
	};

	protected constructor({
		name,
		events,
		data,
		client,
		blockPageSize,
		chainId,
		address,
		startBlock,
	}: Parameters<Events, Data>) {
		this.#debug = debug(`safenet:indexing:${name}`);
		this.#contract = `${chainId}:${getAddress(address)}`;
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

		this.#data = data;
		this.#data.db.exec(`
			CREATE TABLE IF NOT EXISTS event_indexers(
				name TEXT NOT NULL,
				contract TEXT NOT NULL,
				last_block_number INTEGER NOT NULL,
				last_block_timestamp INTEGER NOT NULL,
				PRIMARY KEY(name)
			) WITHOUT ROWID;
		`);

		// Initialize the indexer based on the starting block. We also detect
		// if the indexer was created with a different "identifier" to prevent
		// issues where the same configuration is used for indexing multiple
		// Safenet instances (which would corrupt our data).
		const insert = this.#data.db
			.prepare(`
				INSERT INTO event_indexers(name, contract, last_block_number, last_block_timestamp)
				VALUES ('${name}', '${this.#contract}', @number, 0)
				ON CONFLICT(name)
				DO UPDATE SET last_block_number = MAX(last_block_number, EXCLUDED.last_block_number)
				WHERE contract = '${this.#contract}'
			`)
			.run({ number: (startBlock ?? 0n) - 1n });
		if (insert.changes === 0) {
			throw new Error("event indexer connected to the wrong database");
		}

		this.#queries = {
			selectIndexer: this.#data.db.prepare<[], BlockTimestamp<number>>(`
				SELECT last_block_number as number
				, last_block_timestamp as timestamp
				FROM event_indexers
				WHERE name = '${name}'
			`),
			updateIndexer: this.#data.db.prepare<BlockTimestamp, number>(`
				UPDATE event_indexers
				SET last_block_number = @number
				, last_block_timestamp = @timestamp
				WHERE name = '${name}'
			`),
			addEvents: this.#data.db.transaction(
				({ block, logs }: { block: BlockTimestamp; logs: Log<Events>[] }) => {
					this.#queries.updateIndexer.run(block);
					for (const log of logs) {
						this.insertEvent(log);
					}
				},
			),
		};
	}

	protected get data(): Data {
		return this.#data;
	}

	#lastBlock(): BlockTimestamp {
		const latest = this.#queries.selectIndexer.get();
		if (latest === undefined) {
			throw new Error("Event indexer not initialized");
		}
		return {
			number: BigInt(latest.number),
			timestamp: BigInt(latest.timestamp),
		};
	}

	#seed(): void {
		const last = this.#lastBlock();
		const fromBlock = last.number + 1n;
		const to = this.seed(this.#contract, { fromBlock });
		if (to !== null) {
			this.#queries.updateIndexer.run(to);
		}
	}

	async #nextPage(range: {
		toTimestamp: bigint;
		latest: BlockTimestamp;
	}): Promise<BlockPage | null> {
		const last = this.#lastBlock();
		if (last.timestamp >= range.toTimestamp) {
			return null;
		}

		const fromBlock = last.number + 1n;
		const toBlock = minBigInt(fromBlock + this.#blockPageSize - 1n, range.latest.number);
		const { timestamp } =
			toBlock === range.latest.number
				? range.latest
				: await getBlock(this.#client, { blockNumber: toBlock });
		return { fromBlock, toBlock, toTimestamp: timestamp };
	}

	async update(to: Partial<ToTimestamp> = {}, cancel?: () => boolean): Promise<BlockTimestamp> {
		// Allow the indexer to seed themselves with the latest data. This will
		// permit us to skip indexing specific block ranges for certain events
		// (in particular the sancions list). We do this in update to ensure
		// that updated seed data gets reflected in storage even if the DB was
		// already initialized but on an old block.
		this.#seed();

		const start = this.#lastBlock();
		if (start.number >= 0n && start.timestamp === 0n) {
			// On startup we set the timestamp to 0, fetch it from the block
			// chain on first update.
			const { timestamp } = await getBlock(this.#client, { blockNumber: start.number });
			start.timestamp = timestamp;
			this.#queries.updateIndexer.run(start);
		}

		if (to.toTimestamp !== undefined && to.toTimestamp <= start.timestamp) {
			return start;
		}

		const latest = await getBlock(this.#client, { blockTag: "latest" });
		const range = {
			latest,
			toTimestamp: to.toTimestamp ?? latest.timestamp,
		};
		const timeSpan = Number(range.toTimestamp - start.timestamp);

		while (cancel?.() !== true) {
			const page = await this.#nextPage(range);
			if (page === null) {
				break;
			}

			const { toTimestamp, ...blocks } = page;
			const progress = 100 * Math.min(Number(toTimestamp - start.timestamp) / timeSpan, 1);
			this.#debug(`fetching block page ${formatRange(blocks)} (${progress.toFixed(2)}%)`);

			const logs = await this.#backoff(() =>
				getLogs(this.#client, {
					...this.#filter,
					...blocks,
				}),
			);

			this.#queries.addEvents({
				block: { number: blocks.toBlock, timestamp: toTimestamp },
				logs: sortLogs(logs),
			});
			this.#debug(`indexed ${logs.length} logs`);
		}

		return this.#lastBlock();
	}

	protected seed(_contract: string, _from: FromBlock): BlockTimestamp | null {
		return null;
	}
	protected abstract insertEvent(log: Log<Events>): void;
}

const sortLogs = <Events extends AbiEvent[]>(logs: ParsedLog<Events>[]): Log<Events>[] => {
	return logs
		.sort((a, b) =>
			a.blockNumber < b.blockNumber
				? -1
				: a.blockNumber > b.blockNumber
					? 1
					: a.logIndex - b.logIndex,
		)
		.map(({ blockTimestamp, eventName, args }) => {
			if (blockTimestamp === undefined) {
				throw new Error(
					"Indexing requires logs with block timestamps, use a different node provider",
				);
			}
			return { blockTimestamp, eventName, args };
		}) as unknown as Log<Events>[];
};
