import type { Database, Statement } from "better-sqlite3";
import type { Address, Hex } from "viem";
import type { TimestampRange } from "../utils/ranges.js";

export type SentinelParticipationSummary = {
	total: number;
	sentinels: Record<Address, number>;
};

export type SentinelOracleContract = {
	/** The oracle contract identifier, i.e. `'chainId:0xChecksummedAddress'`. */
	contract: string;
};

export type Sentinel = {
	address: Address;
};

export type SentinelRequest = SentinelOracleContract & {
	requestId: Hex;
	blockTimestamp: bigint;
};

export type SentinelReveal<bool = boolean> = SentinelOracleContract & {
	requestId: Hex;
	sentinel: Address;
	approved: bool;
};

type SentinelParticipationCount = {
	sentinel: Address;
	count: number;
};

export class SentinelData {
	#db: Database;
	#queries: {
		upsertOracle: Statement<SentinelOracleContract, number>;
		upsertSentinel: Statement<Sentinel, number>;
		insertRequest: Statement<SentinelRequest, number>;
		insertReveal: Statement<SentinelReveal<0 | 1>, number>;
		selectRequestCount: Statement<TimestampRange, number>;
		selectParticipation: Statement<TimestampRange, SentinelParticipationCount>;
	};

	constructor({ db }: { db: Database }) {
		this.#db = db;
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS sentinel_oracles(
				id INTEGER NOT NULL,
				contract TEXT NOT NULL,
				PRIMARY KEY(id),
				UNIQUE(contract)
			);

			CREATE TABLE IF NOT EXISTS sentinels(
				id INTEGER NOT NULL,
				address TEXT NOT NULL,
				PRIMARY KEY(id),
				UNIQUE(address)
			);

			CREATE TABLE IF NOT EXISTS sentinel_requests(
				id INTEGER NOT NULL,
				oracle INTEGER NOT NULL,
				request_id TEXT NOT NULL,
				block_timestamp INTEGER NOT NULL,
				PRIMARY KEY(id),
				UNIQUE(oracle, request_id)
			);
			CREATE INDEX IF NOT EXISTS sentinel_request_block_timestamp_idx
			ON sentinel_requests(block_timestamp);

			CREATE TABLE IF NOT EXISTS sentinel_reveals(
				request INTEGER NOT NULL,
				sentinel INTEGER NOT NULL,
				approved INTEGER NOT NULL,
				PRIMARY KEY(request, sentinel)
			) WITHOUT ROWID;
		`);
		this.#queries = {
			upsertOracle: this.#db.prepare<SentinelOracleContract, number>(`
				INSERT INTO sentinel_oracles(contract)
				VALUES(@contract)
				ON CONFLICT(contract)
				DO NOTHING
			`),
			upsertSentinel: this.#db.prepare<Sentinel, number>(`
				INSERT INTO sentinels(address)
				VALUES(@address)
				ON CONFLICT(address)
				DO NOTHING
			`),
			insertRequest: this.#db.prepare<SentinelRequest, number>(`
				INSERT INTO sentinel_requests(oracle, request_id, block_timestamp)
				VALUES((SELECT id FROM sentinel_oracles WHERE contract = @contract)
				, @requestId
				, @blockTimestamp)
				ON CONFLICT(oracle, request_id)
				DO NOTHING
			`),
			// Reveals are inserted by selecting their request, so that a reveal
			// for an unknown request inserts no row instead of failing on the
			// `NOT NULL` surrogate key (see `registerReveal`). Note that the
			// `WHERE` clause is also required for SQLite to unambiguously parse
			// the `ON CONFLICT` clause as an upsert.
			insertReveal: this.#db.prepare<SentinelReveal<0 | 1>, number>(`
				INSERT INTO sentinel_reveals(request, sentinel, approved)
				SELECT r.id
				, (SELECT id FROM sentinels WHERE address = @sentinel)
				, @approved
				FROM sentinel_requests AS r
				WHERE r.oracle = (SELECT id FROM sentinel_oracles WHERE contract = @contract)
				AND r.request_id = @requestId
				ON CONFLICT(request, sentinel)
				DO NOTHING
			`),
			selectRequestCount: this.#db.prepare<TimestampRange, number>(`
				SELECT COUNT(*) AS count
				FROM sentinel_requests
				WHERE block_timestamp >= @fromTimestamp
				AND block_timestamp <= @toTimestamp
			`),
			// Reveals are attributed to the period of the request they belong
			// to and not to the period they were revealed in, mirroring how
			// signature shares are attributed to their signing ceremony in
			// `AttestationData`. This keeps the numerator and the denominator
			// keyed on the same unit, so the participation rate is always in
			// the `[0, 1]` range.
			selectParticipation: this.#db.prepare<TimestampRange, SentinelParticipationCount>(`
				SELECT n.address AS sentinel
				, COUNT(*) AS count
				FROM sentinel_requests AS r
				INNER JOIN sentinel_reveals AS v
				ON v.request = r.id
				INNER JOIN sentinels AS n
				ON n.id = v.sentinel
				WHERE r.block_timestamp >= @fromTimestamp
				AND r.block_timestamp <= @toTimestamp
				GROUP BY v.sentinel
			`),
		};
	}

	get db() {
		return this.#db;
	}

	registerOracle({ contract }: SentinelOracleContract): void {
		this.#queries.upsertOracle.run({ contract });
	}

	registerRequest({ contract, requestId, blockTimestamp }: SentinelRequest): void {
		this.#queries.upsertOracle.run({ contract });
		this.#queries.insertRequest.run({ contract, requestId, blockTimestamp });
	}

	registerReveal({ contract, requestId, sentinel, approved }: SentinelReveal): void {
		this.#queries.upsertSentinel.run({ address: sentinel });

		// A reveal whose `NewRequest` was never indexed - i.e. the request was
		// created before the oracle's configured start block - is skipped. This
		// is also the correct accounting outcome, as the request is missing from
		// the participation denominator, so its reveals must be missing from
		// the numerator as well.
		//
		// Note that this is the only ordering hazard here: both events come
		// from the same indexer, and logs are processed in `(blockNumber,
		// logIndex)` order, so a `Revealed` can never be indexed before the
		// `NewRequest` it belongs to.
		this.#queries.insertReveal.run({
			contract,
			requestId,
			sentinel,
			approved: Number(approved) as 0 | 1,
		});
	}

	requestCount(period: TimestampRange): number {
		return this.#queries.selectRequestCount.pluck().get(period) ?? 0;
	}

	participation(period: TimestampRange): SentinelParticipationSummary {
		const total = this.requestCount(period);
		const counts = this.#queries.selectParticipation.all(period);
		const sentinels = Object.fromEntries(counts.map(({ sentinel, count }) => [sentinel, count]));
		return {
			total,
			sentinels,
		};
	}
}
