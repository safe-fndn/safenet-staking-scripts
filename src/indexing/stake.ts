import type { Statement } from "better-sqlite3";
import { type Address, getAbiItem } from "viem";
import { STAKING_ABI } from "../abi.js";
import { maxBigInt } from "../utils/math.js";
import type { BlockRange, TimestampRange } from "../utils/ranges.js";
import type { BlockTimestampCache } from "./block.js";
import { type Configuration, EventIndexer, type ParsedLog } from "./events.js";

const EVENTS = [
	getAbiItem({ abi: STAKING_ABI, name: "StakeIncreased" }),
	getAbiItem({ abi: STAKING_ABI, name: "WithdrawalInitiated" }),
];

export type Parameters = Configuration & {
	blocks: BlockTimestampCache;
};

export type StakeSelector = {
	staker: Address;
	validator: Address;
};

export type Staked = StakeSelector & {
	amount: bigint;
};

export type AverageStakeSelector = StakeSelector & TimestampRange;

type StakeAtBlock = {
	blockNumber: number;
	logIndex: number;
	amount: string;
};

type StakeChange = StakeSelector & {
	blockNumber: bigint;
	logIndex: number;
	amount: string;
};

type StakeAmount = {
	blockNumber: number;
	amount: string;
};

type SelectStakeAmounts = StakeSelector & BlockRange;

export class Stake extends EventIndexer<typeof EVENTS> {
	#queries: {
		selectLatestStake: Statement<StakeSelector, StakeAtBlock>;
		upsertStake: Statement<StakeChange, number>;
		selectStakeAmounts: Statement<SelectStakeAmounts, StakeAmount>;
		selectStakeBlocks: Statement<BlockRange, number>;
		selectStakers: Statement<BlockRange, StakeSelector>;
	};

	constructor(config: Configuration) {
		super({
			name: "stake",
			events: EVENTS,
			...config,
		});

		this.db.exec(`
			CREATE TABLE IF NOT EXISTS stake(
				contract TEXT NOT NULL,
				block_number INTEGER NOT NULL,
				log_index INTEGER NOT NULL,
				staker TEXT NOT NULL,
				validator TEXT NOT NULL,
				amount TEXT NOT NULL,
				PRIMARY KEY(contract, block_number, staker, validator)
			);
		`);
		this.#queries = {
			selectLatestStake: this.db.prepare<StakeSelector, StakeAtBlock>(`
				SELECT block_number as blockNumber
				, log_index as logIndex
				, amount
				FROM stake
				WHERE contract = '${this.contract}'
				AND staker = @staker
				AND validator = @validator
				ORDER BY block_number DESC
				LIMIT 1
			`),
			upsertStake: this.db.prepare<StakeChange, number>(`
				INSERT INTO stake(contract, block_number, log_index, staker, validator, amount)
				VALUES('${this.contract}', @blockNumber, @logIndex, @staker, @validator, @amount)
				ON CONFLICT(contract, block_number, staker, validator)
				DO UPDATE SET log_index = EXCLUDED.log_index
				, amount = EXCLUDED.amount
			`),
			selectStakeAmounts: this.db.prepare<SelectStakeAmounts, StakeAmount>(`
				WITH starting_stake AS (
					SELECT block_number AS starting_block_number
					, amount AS starting_amount
					FROM stake
					WHERE contract = '${this.contract}'
					AND block_number < @fromBlock
					AND staker = @staker
					AND validator = @validator
					ORDER BY block_number DESC
					LIMIT 1
				)
				SELECT COALESCE(block_number, starting_block_number) as blockNumber
				, COALESCE(amount, starting_amount) AS amount
				FROM stake
				FULL OUTER JOIN starting_stake
				ON 1 = 0
				WHERE contract = '${this.contract}'
				AND block_number >= @fromBlock
				AND block_number <= @toBlock
				AND staker = @staker
				AND validator = @validator
			`),
			selectStakeBlocks: this.db.prepare<BlockRange, number>(`
				SELECT DISTINCT(block_number)
				FROM stake
				WHERE contract = '${this.contract}'
				AND block_number >= @fromBlock
				AND block_number <= @toBlock
			`),
			selectStakers: this.db.prepare<BlockRange, StakeSelector>(`
				WITH starting_stake AS (
					SELECT staker
					, validator
					, amount
					FROM stake
					WHERE contract = '${this.contract}'
					AND block_number < @fromBlock
					GROUP BY staker, validator
					ORDER BY block_number DESC
					LIMIT 1
				)
				, starters AS (
					SELECT staker
					, validator
					FROM starting_stake
					WHERE amount != '0'
				)
				, adders AS (
					SELECT staker
					, validator
					FROM stake
					WHERE contract = '${this.contract}'
					AND block_number >= @fromBlock
					AND block_number <= @toBlock
					AND amount != '0'
				)
				, pairs AS (
					SELECT COALESCE(starters.staker, adders.staker) AS staker
					, COALESCE(starters.validator, adders.validator) AS validator
					FROM starters
					FULL OUTER JOIN adders
					ON starters.staker = adders.staker
					AND starters.validator = adders.validator
				)
				SELECT staker
				, validator
				FROM pairs
				GROUP BY staker, validator
			`),
		};
	}

	protected insertEvent(log: ParsedLog<typeof EVENTS>): void {
		// Ideally, we would update the amount in a single query. However,
		// unfortunately, `better-sqlite3` does not build the `decimal`
		// extension into its `sqlite3` bundle, meaning we cannot do arbitrary
		// precision math. Note that `insertEvent` is always executed within a
		// transaction.
		const { blockNumber, logIndex, amount } = this.#queries.selectLatestStake.get(log.args) ?? {
			blockNumber: 0,
			logIndex: 0,
			amount: "0",
		};
		if (
			BigInt(blockNumber) > log.blockNumber ||
			(BigInt(blockNumber) === log.blockNumber && logIndex >= log.logIndex)
		) {
			throw new Error("event out of order");
		}

		const delta = log.eventName === "StakeIncreased" ? log.args.amount : -log.args.amount;
		const newAmount = BigInt(amount) + delta;
		if (newAmount < 0n) {
			throw new Error("withdrawal overflow");
		}

		this.#queries.upsertStake.run({
			blockNumber: log.blockNumber,
			logIndex: log.logIndex,
			staker: log.args.staker,
			validator: log.args.validator,
			amount: `${newAmount}`,
		});
	}

	async averageStake(selector: AverageStakeSelector): Promise<bigint> {
		const range = await this.blocks.blockRange(selector);
		const amounts = this.#queries.selectStakeAmounts.all({
			...selector,
			...range,
		});
		amounts.sort((a, b) => a.blockNumber - b.blockNumber);

		let timeweight = 0n;
		let last = { amount: 0n, timestamp: 0n };
		for (const { blockNumber, amount } of amounts) {
			const timestamp = maxBigInt(
				await this.blocks.mustGetTimestamp({ blockNumber: BigInt(blockNumber) }),
				selector.fromTimestamp,
			);
			timeweight += last.amount * (timestamp - last.timestamp);
			last = { amount: BigInt(amount), timestamp };
		}

		timeweight += last.amount * (selector.toTimestamp - last.timestamp);
		return timeweight / (selector.toTimestamp - selector.fromTimestamp);
	}

	async *staked(period: TimestampRange): AsyncGenerator<Staked> {
		const range = await this.blocks.blockRange(period);

		// Prefetch missing block timestamps for the range. We will need these
		// for computing the average stake anyway, and cannot update the cache
		// while we are iterating over results.
		const blocks = this.#queries.selectStakeBlocks.pluck().all(range);
		for (const block of blocks) {
			await this.blocks.mustGetTimestamp({ blockNumber: BigInt(block) });
		}

		const stakers = this.#queries.selectStakers.iterate(range);
		for (const selector of stakers) {
			const amount = await this.averageStake({ ...selector, ...period });
			yield { ...selector, amount: BigInt(amount) };
		}
	}
}
