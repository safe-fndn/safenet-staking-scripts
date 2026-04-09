import type { Statement } from "better-sqlite3";
import { type Address, getAbiItem } from "viem";
import { STAKING_ABI } from "../abi.js";
import { maxBigInt } from "../utils/math.js";
import { rangeDuration, type TimestampRange } from "../utils/ranges.js";
import { type Configuration, EventIndexer, type Log } from "./events.js";

const EVENTS = [
	getAbiItem({ abi: STAKING_ABI, name: "StakeIncreased" }),
	getAbiItem({ abi: STAKING_ABI, name: "WithdrawalInitiated" }),
];

export type StakeSelector = {
	staker: Address;
	validator: Address;
};

export type AverageStakeSelector = StakeSelector & TimestampRange;

type StakeTimestamp<I = bigint> = {
	blockTimestamp: I;
	amount: string;
};

type StakeChange = StakeSelector & StakeTimestamp;

type StakeAmount = {
	blockTimestamp: number;
	validator: Address;
	amount: string;
};

type SelectStakeAmounts = StakeSelector & TimestampRange;

export class Stake extends EventIndexer<typeof EVENTS> {
	#queries: {
		selectLatestStake: Statement<StakeSelector, StakeTimestamp>;
		upsertStake: Statement<StakeChange, number>;
		selectStakeAmounts: Statement<SelectStakeAmounts, StakeAmount>;
		selectStakeBlocks: Statement<TimestampRange, number>;
		selectStakers: Statement<TimestampRange, Address>;
	};

	constructor(config: Configuration) {
		super({
			name: "stake",
			events: EVENTS,
			...config,
		});

		this.db.exec(`
			CREATE TABLE IF NOT EXISTS stake(
				block_timestamp INTEGER NOT NULL,
				staker TEXT NOT NULL,
				validator TEXT NOT NULL,
				amount TEXT NOT NULL,
				PRIMARY KEY(block_timestamp, staker, validator)
			) WITHOUT ROWID;
		`);
		this.#queries = {
			selectLatestStake: this.db.prepare<StakeSelector, StakeTimestamp>(`
				SELECT block_timestamp as blockTimestamp
				, amount
				FROM stake
				WHERE staker = @staker
				AND validator = @validator
				ORDER BY block_timestamp DESC
				LIMIT 1
			`),
			upsertStake: this.db.prepare<StakeChange, number>(`
				INSERT INTO stake(block_timestamp, staker, validator, amount)
				VALUES(@blockTimestamp, @staker, @validator, @amount)
				ON CONFLICT(block_timestamp, staker, validator)
				DO UPDATE SET amount = EXCLUDED.amount
			`),
			selectStakeAmounts: this.db.prepare<SelectStakeAmounts, StakeAmount>(`
				WITH starting_stake AS (
					SELECT block_timestamp AS blockTimestamp
					, amount
					FROM stake
					WHERE block_timestamp < @fromTimestamp
					AND staker = @staker
					AND validator = @validator
					ORDER BY block_timestamp DESC
					LIMIT 1
				)
				SELECT * FROM starting_stake
				UNION ALL
				SELECT block_timestamp as blockTimestamp
				, amount
				FROM stake
				WHERE block_timestamp >= @fromTimestamp
				AND block_timestamp <= @toTimestamp
				AND staker = @staker
				AND validator = @validator
			`),
			selectStakeBlocks: this.db.prepare<TimestampRange, number>(`
				WITH starting_stake AS (
					SELECT block_timestamp
					, amount
					, row_number() OVER (
						PARTITION BY staker, validator
						ORDER BY block_timestamp DESC
					) AS n
					FROM stake
					WHERE block_timestamp < @fromTimestamp
				)
				SELECT DISTINCT(block_timestamp) AS blockTimestamp
				FROM starting_stake
				WHERE amount != '0'
				AND n = 1
				UNION ALL
				SELECT DISTINCT(block_timestamp) as blockTimestamp
				FROM stake
				WHERE block_timestamp >= @fromTimestamp
				AND block_timestamp <= @toTimestamp
			`),
			selectStakers: this.db.prepare<TimestampRange, Address>(`
				WITH starting_stake AS (
					SELECT staker
					, amount
					, row_number() OVER (
						PARTITION BY staker, validator
						ORDER BY block_timestamp DESC
					) AS n
					FROM stake
					WHERE block_timestamp < @fromTimestamp
				)
				, all_stakers AS (
					SELECT staker
					FROM starting_stake
					WHERE amount != '0'
					AND n = 1
					UNION ALL
					SELECT staker
					FROM stake
					WHERE block_timestamp >= @fromTimestamp
					AND block_timestamp <= @toTimestamp
					AND amount != '0'
				)
				SELECT DISTINCT(staker) AS staker
				FROM all_stakers
				ORDER BY staker COLLATE NOCASE ASC
			`),
		};
	}

	protected insertEvent(log: Log<typeof EVENTS>): void {
		// Ideally, we would update the amount in a single query. However,
		// unfortunately, `better-sqlite3` does not build the `decimal`
		// extension into its `sqlite3` bundle, meaning we cannot do arbitrary
		// precision math. Note that `insertEvent` is always executed within a
		// transaction.
		const { blockTimestamp, amount } = this.#queries.selectLatestStake.get(log.args) ?? {
			blockTimestamp: 0,
			amount: "0",
		};
		if (BigInt(blockTimestamp) > log.blockTimestamp) {
			throw new Error("event out of order");
		}

		const delta = log.eventName === "StakeIncreased" ? log.args.amount : -log.args.amount;
		const newAmount = BigInt(amount) + delta;
		if (newAmount < 0n) {
			throw new Error("withdrawal overflow");
		}

		this.#queries.upsertStake.run({
			blockTimestamp: log.blockTimestamp,
			staker: log.args.staker,
			validator: log.args.validator,
			amount: `${newAmount}`,
		});
	}

	timeWeightedStake({ staker, validator, ...period }: AverageStakeSelector): bigint {
		const amounts = this.#queries.selectStakeAmounts.all({
			staker,
			validator,
			...period,
		});
		amounts.sort((a, b) => a.blockTimestamp - b.blockTimestamp);

		let weighted = 0n;
		let last = { amount: 0n, timestamp: 0n };
		for (const { amount, blockTimestamp } of amounts) {
			const timestamp = maxBigInt(BigInt(blockTimestamp), period.fromTimestamp);
			weighted += last.amount * (timestamp - last.timestamp);
			last = { amount: BigInt(amount), timestamp };
		}

		weighted += last.amount * (period.toTimestamp - last.timestamp);
		return weighted;
	}

	averageStake(params: AverageStakeSelector): bigint {
		const weighted = this.timeWeightedStake(params);
		return weighted / rangeDuration(params);
	}

	*stakers(period: TimestampRange): Generator<Address> {
		const stakers = this.#queries.selectStakers.pluck().iterate(period);
		for (const staker of stakers) {
			yield staker;
		}
	}
}
