/**
 * A general purpose event indexer.
 *
 * This stores events into a SQLite database in order to cache log queries
 * instead of always fetching them from the node.
 */

import type { Database, Statement, Transaction } from "better-sqlite3";
import { type AbiEvent, type Address, type Client, type Log, toEventSelector } from "viem";
import { getLogs } from "viem/actions";
import { z } from "zod";
import { jsonPreprocessor, jsonReplacer } from "./utils/json.js";
import { type BlockRange, nextPage, type PagedBlockRange, reduceRanges } from "./utils/ranges.js";

export type Configuration<Event> = {
	db: Database;
	address: Address;
	event: Event;
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

type ParsedLog<Event extends AbiEvent> = Log<bigint, number, false, Event>;

export class Indexer<Event extends AbiEvent> {
	#db: Database;
	#filter: {
		address: Address;
		event: Event;
		strict: true;
	};
	#table: string;
	#queries: {
		selectIndexedRanges: Statement<[], string>;
		upsertIndexedRanges: Statement<{ ranges: string }, number>;
		insertEvent: Statement<{ block: bigint; index: number; args: string }, number>;
		addEvents: Transaction<(args: { page: BlockRange; logs: Log[] }) => void>;
	};

	constructor({ db, address, event }: Configuration<Event>) {
		this.#db = db;
		this.#filter = {
			address,
			event,
			strict: true,
		};

		// We create a unique table per address and event. This ensures that we
		// don't accidentally mix up events with different signatures accross
		// or different contracts.
		this.#table = `indexer_${address}_${toEventSelector(event)}`;

		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS indexer_ranges(
				table TEXT NOT NULL,
				ranges TEXT NOT NULL,
				PRIMARY KEY(table)
			);
			CREATE INDEX IF NOT EXISTS indexer_updates_table_idx ON indexer_updates(table);

			CREATE TABLE IF NOT EXISTS ${this.#table}(
				block INTEGER NOT NULL,
				index INTEGER NOT NULL,
				args TEXT NOT NULL,
				PRIMARY KEY(block, index)
			);
		`);

		this.#queries = {
			selectIndexedRanges: this.#db
				.prepare<[], string>(`
					SELECT ranges
					FROM indexer_ranges
					WHERE table = '${this.#table}'
				`)
				.pluck(),
			upsertIndexedRanges: this.#db
				.prepare<{ ranges: string }, number>(`
					INSERT INTO indexer_ranges(table, ranges)
					VALUES('${this.#table}', @ranges)
					ON CONFLICT(table)
					DO UPDATE SET ranges = excluded.ranges
				`)
				.pluck(),
			insertEvent: this.#db
				.prepare<{ block: bigint; index: number; args: string }, number>(`
					INSERT INTO ${this.#table}(block, index, args)
					VALUES(@block, @index, @args)
					ON CONFLICT(block, index)
					DO NOTHING
				`)
				.pluck(),
			addEvents: this.#db.transaction(
				({ page, logs }: { page: BlockRange; logs: ParsedLog<Event>[] }) => {
					// Update atomically, preventing any undefined behaviour in
					// case we are running multiple indexers for the same event.
					const ranges = reduceRanges([page, ...this.#indexedRanges()]);
					this.#queries.upsertIndexedRanges.run({ ranges: JSON.stringify(ranges, jsonReplacer) });
					for (const { blockNumber, logIndex, args } of logs) {
						this.#queries.insertEvent.run({
							block: blockNumber,
							index: logIndex,
							args: JSON.stringify(args, jsonReplacer),
						});
					}
				},
			),
		};
	}

	#indexedRanges(): BlockRange[] {
		return rangesSchema.safeParse(this.#queries.selectIndexedRanges.get()).data ?? [];
	}

	#nextPage(range: PagedBlockRange): BlockRange | null {
		return nextPage(range, this.#indexedRanges());
	}

	async update(client: Client, range: PagedBlockRange): Promise<void> {
		while (true) {
			const page = this.#nextPage(range);
			if (page === null) {
				break;
			}

			const logs = await getLogs(client, {
				...this.#filter,
				...page,
			});
			this.#queries.addEvents({ page, logs });
		}
	}
}
