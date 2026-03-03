/**
 * A block timestamp cache.
 *
 * Safenet rewards use time-weighted averages, instead of based on block ranges.
 * This component keeps a local cache of block tiemstamps, in order to speed up
 * average staking calculations.
 */

import type { Database, Statement } from "better-sqlite3";
import debug, { type Debugger } from "debug";
import { BlockNotFoundError, type Client, type Log } from "viem";
import { getBlock } from "viem/actions";
import { type Backoff, backoff } from "../utils/backoff.js";

export type Configuration = {
	db: Database;
	client: Client;
	chainId: number;
};

export type BlockTimestamp = {
	blockNumber: bigint;
	timestamp: bigint;
};

export type TimestampRange = {
	fromTimestamp: bigint;
	toTimestamp: bigint;
};

export type BlockRange = {
	fromBlock: bigint;
	toBlock: bigint;
};

export class BlockTimestampCache {
	#debug: Debugger;
	#db: Database;
	#client: Client;
	#backoff: Backoff;
	#table: string;
	#queries: {
		selectTimestamp: Statement<{ blockNumber: bigint }, number>;
		upsertTimestamp: Statement<BlockTimestamp, number>;
		selectBlockAfterTimestamp: Statement<
			{ timestamp: bigint },
			{ blockNumber: number; timestamp: number }
		>;
	};

	constructor({ db, client, chainId }: Configuration) {
		this.#debug = debug(`safenet:indexing:block`);
		this.#db = db;
		this.#client = client;
		this.#backoff = backoff({
			debug: this.#debug,
		});

		// We create separate tables per chain.
		this.#table = `block_timestamps_${chainId}`;

		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS ${this.#table}(
				block_number INTEGER NOT NULL,
				timestamp INTEGER NOT NULL,
				PRIMARY KEY(block_number)
			);
		`);

		this.#queries = {
			selectTimestamp: this.#db.prepare<{ blockNumber: bigint }, number>(`
				SELECT timestamp
				FROM ${this.#table}
				WHERE block_number = @blockNumber
			`),
			upsertTimestamp: this.#db.prepare<BlockTimestamp, number>(`
				INSERT INTO ${this.#table}(block_number, timestamp)
				VALUES(@blockNumber, @timestamp)
				ON CONFLICT(block_number)
				DO NOTHING
			`),
			selectBlockAfterTimestamp: this.#db.prepare<
				{ timestamp: bigint },
				{ blockNumber: number; timestamp: number }
			>(`
				SELECT block_number AS blockNumber, timestamp
				FROM ${this.#table}
				WHERE timestamp >= @timestamp
				ORDER BY block_number ASC
				LIMIT 1
			`),
		};
	}

	get table(): string {
		return this.#table;
	}

	async getLatest(): Promise<BlockTimestamp> {
		const block = await this.#backoff(() => getBlock(this.#client, { blockTag: "latest" }));
		const result = {
			blockNumber: block.number,
			timestamp: block.timestamp,
		};
		this.#queries.upsertTimestamp.run(result);
		return result;
	}

	async getTimestamp({ blockNumber }: Pick<BlockTimestamp, "blockNumber">): Promise<bigint | null> {
		const cached = this.#queries.selectTimestamp.pluck().get({ blockNumber });
		if (cached !== undefined) {
			return BigInt(cached);
		}

		const block = await this.#backoff(async () => {
			try {
				return await getBlock(this.#client, { blockNumber });
			} catch (err) {
				if (err instanceof BlockNotFoundError) {
					return null;
				}
				throw err;
			}
		});
		if (block === null) {
			return null;
		}

		this.#queries.upsertTimestamp.run({
			blockNumber: block.number,
			timestamp: block.timestamp,
		});
		return block.timestamp;
	}

	async searchBlock({
		timestamp,
	}: Pick<BlockTimestamp, "timestamp">): Promise<BlockTimestamp | null> {
		const cached = this.#queries.selectBlockAfterTimestamp.get({ timestamp });
		if (cached && BigInt(cached.timestamp) === timestamp) {
			return bt(cached);
		}

		if (cached) {
			// We found a block, but we don't know for sure whether or not it
			// matches the timestamp, which may fall between two blocks. We need
			// to get the block immediately before and check whether it comes
			// before the timestamp. If it does, then we found our block. If it
			// doesn't, fall back to binary searching.
			const before = await this.getTimestamp({ blockNumber: BigInt(cached.blockNumber - 1) });
			if (before !== null && before < timestamp) {
				return bt(cached);
			}
		}

		// Binary search to find the block we are looking for. In the future,
		// this can be optimized a bit by "guessing" where the correct block
		// number based on average block times.
		const high = await this.getLatest();
		const low = { blockNumber: -1n, timestamp: 0n };
		while (high.blockNumber - low.blockNumber > 1n) {
			const mid = (high.blockNumber + low.blockNumber) / 2n;
			const t = await this.getTimestamp({ blockNumber: mid });
			if (t === null) {
				throw new Error(`unexpected missing block ${mid}`);
			} else if (t < timestamp) {
				low.blockNumber = mid;
				low.timestamp = t;
			} else if (t > timestamp) {
				high.blockNumber = mid;
				high.timestamp = t;
			} else {
				return { blockNumber: mid, timestamp: t };
			}
		}
		return high;
	}

	async searchBlockRange({
		fromTimestamp,
		toTimestamp,
	}: TimestampRange): Promise<BlockRange | null> {
		const fromBlock = await this.searchBlock({ timestamp: fromTimestamp });
		if (fromBlock === null) {
			return null;
		}
		const upToBlock = await this.searchBlock({ timestamp: toTimestamp });
		if (upToBlock === null || upToBlock.blockNumber <= fromBlock.blockNumber) {
			return null;
		}
		return { fromBlock: fromBlock.blockNumber, toBlock: upToBlock.blockNumber - 1n };
	}

	recordLog({
		blockNumber,
		blockTimestamp,
	}: Pick<Log<bigint, number, false>, "blockNumber" | "blockTimestamp">): boolean {
		if (blockTimestamp === undefined) {
			return false;
		}
		this.#queries.upsertTimestamp.run({ blockNumber, timestamp: blockTimestamp });
		return true;
	}
}

const bt = (b: { blockNumber: number; timestamp: number }): BlockTimestamp => ({
	blockNumber: BigInt(b.blockNumber),
	timestamp: BigInt(b.timestamp),
});
