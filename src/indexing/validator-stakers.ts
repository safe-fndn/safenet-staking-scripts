import type { Statement } from "better-sqlite3";
import { type Address, getAbiItem, zeroAddress } from "viem";
import { CONSENSUS_ABI } from "../abi.js";
import type { BlockRange, TimestampRange } from "../utils/ranges.js";
import { type Configuration, EventIndexer, type ParsedLog } from "./events.js";

const EVENTS = [getAbiItem({ abi: CONSENSUS_ABI, name: "ValidatorStakerSet" })];

export type ValidatorStakerPeriod = {
	validator: Address;
} & TimestampRange;

export type ValidatorStaker = {
	staker: Address;
} & TimestampRange;

type StakerUpdate = {
	blockNumber: bigint | number;
	logIndex: number;
	validator: Address;
	staker: Address;
};

type StakerRange = {
	validator: Address;
} & BlockRange;

type StakerChange = {
	blockNumber: number;
	staker: Address;
};

export class ValidatorStakers extends EventIndexer<typeof EVENTS> {
	#queries: {
		upsertStaker: Statement<StakerUpdate, number>;
		selectStartingStaker: Statement<StakerRange, Address>;
		selectStakerChanges: Statement<StakerRange, StakerChange>;
	};

	constructor(config: Configuration) {
		super({
			name: "validator-stakers",
			events: EVENTS,
			...config,
		});

		this.db.exec(`
			CREATE TABLE IF NOT EXISTS validator_stakers(
				contract TEXT NOT NULL,
				block_number INTEGER NOT NULL,
				log_index INTEGER NOT NULL,
				validator TEXT NOT NULL,
				staker TEXT NOT NULL,
				PRIMARY KEY(contract, block_number, log_index)
			);
		`);
		this.#queries = {
			upsertStaker: this.db.prepare<StakerUpdate, number>(`
				INSERT INTO validator_stakers(contract, block_number, log_index, validator, staker)
				VALUES('${this.contract}', @blockNumber, @logIndex, @validator, @staker)
				ON CONFLICT(contract, block_number, log_index)
				DO NOTHING
			`),
			selectStartingStaker: this.db.prepare<StakerRange, Address>(`
				SELECT staker
				FROM validator_stakers
				WHERE contract = '${this.contract}'
				AND block_number < @fromBlock
				AND validator = @validator
				ORDER BY block_number DESC, log_index DESC
				LIMIT 1
			`),
			selectStakerChanges: this.db.prepare<StakerRange, StakerChange>(`
				SELECT block_number AS blockNumber
				, staker
				FROM validator_stakers
				WHERE contract = '${this.contract}'
				AND block_number >= @fromBlock
				AND block_number <= @toBlock
				AND validator = @validator
				ORDER BY block_number ASC, log_index ASC
			`),
		};
	}

	protected insertEvent(log: ParsedLog<typeof EVENTS>): void {
		this.#queries.upsertStaker.run({
			blockNumber: log.blockNumber,
			logIndex: log.logIndex,
			validator: log.args.validator,
			staker: log.args.staker,
		});
	}

	async validatorStakers({
		validator,
		...period
	}: ValidatorStakerPeriod): Promise<ValidatorStaker[]> {
		const range = await this.blocks.blockRange(period);
		const staker = this.#queries.selectStartingStaker.pluck().get({ validator, ...range });
		const changes = this.#queries.selectStakerChanges.all({ validator, ...range });

		const stakers = [
			{
				staker: staker ?? zeroAddress,
				...period,
			},
		];
		for (const { blockNumber, staker } of changes) {
			const previous = stakers.at(-1);
			if (previous === undefined) {
				throw new Error("stakers is never empty");
			}

			// Account for the fact that a validator may call set their staker
			// to the same address multiple times.
			if (previous.staker === staker) {
				continue;
			}

			const timestamp = await this.blocks.mustGetTimestamp({ blockNumber: BigInt(blockNumber) });
			previous.toTimestamp = timestamp;
			stakers.push({
				staker,
				...period,
				fromTimestamp: timestamp,
			});
		}

		// Account for the fact that a validator may set the staker to different
		// values in the same block, remove stakers with a 0-duration.
		return stakers.filter((s) => s.fromTimestamp < s.toTimestamp);
	}
}
