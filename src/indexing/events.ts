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
	type Hex,
	type Log,
	toEventSelector,
	toHex,
} from "viem";
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
	#contract: string;
	#uid: string;
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
		upsertIndexer: Statement<{ toBlock: bigint }, number>;
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
		this.#contract = `${chainId}:${getAddress(address)}`;
		this.#uid = `${name}/${this.#contract}/${combineSelectors(events)}`;
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
				uid TEXT NOT NULL,
				to_block INTEGER NOT NULL,
				PRIMARY KEY(uid)
			);
		`);

		this.#queries = {
			selectIndexer: this.#db.prepare<[], number>(`
				SELECT to_block
				FROM event_indexers
				WHERE uid = '${this.#uid}'
			`),
			upsertIndexer: this.#db.prepare<{ toBlock: bigint }, number>(`
				INSERT INTO event_indexers(uid, to_block)
				VALUES('${this.#uid}', @toBlock)
				ON CONFLICT(uid)
				DO UPDATE SET to_block = excluded.to_block
				WHERE excluded.to_block > event_indexers.to_block
			`),
			addEvents: this.#db.transaction(
				({ page, logs }: { page: BlockRange; logs: ParsedLog<Events>[] }) => {
					this.#queries.upsertIndexer.run(page);
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

		// If we have a starting block specified, then we can mark that we have
		// effectively indexed all events prior to that block.
		if (startBlock) {
			this.#queries.upsertIndexer.run({ toBlock: startBlock - 1n });
		}
	}

	protected get contract(): string {
		return this.#contract;
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
		while (cancel?.() !== true) {
			const page = this.#nextPage(range);
			if (page === null) {
				break;
			}
			this.#debug(`fetching block page ${formatRange(page)}`);

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

const combineSelectors = (events: AbiEvent[]): Hex =>
	toHex(
		events.reduce((acc, event) => acc ^ BigInt(toEventSelector(event)), 0n),
		{ size: 32 },
	);
