import type { Statement } from "better-sqlite3";
import { type Address, getAbiItem } from "viem";
import { STAKING_ABI } from "../abi.js";
import {
	type BlockRange,
	type FromBlock,
	reduceRanges,
	type TimestampRange,
} from "../utils/ranges.js";
import { type Configuration, EventIndexer, type ParsedLog } from "./events.js";

const EVENTS = [getAbiItem({ abi: STAKING_ABI, name: "ValidatorUpdated" })];

export type ValidatorSet = Record<Address, TimestampRange[]>;

type ValidatorUpdate = {
	blockNumber: bigint | number;
	logIndex: number;
	validator: Address;
	isRegistered: 0 | 1;
};

export class Validators extends EventIndexer<typeof EVENTS> {
	#queries: {
		upsertValidator: Statement<ValidatorUpdate, number>;
		selectRegisteredValidators: Statement<FromBlock, Address>;
		selectValidatorUpdates: Statement<BlockRange, ValidatorUpdate>;
	};

	constructor(config: Configuration) {
		super({
			name: "validators",
			events: EVENTS,
			...config,
		});

		this.db.exec(`
			CREATE TABLE IF NOT EXISTS validators(
				block_number INTEGER NOT NULL,
				log_index INTEGER NOT NULL,
				validator TEXT NOT NULL,
				is_registered INTEGER NOT NULL,
				PRIMARY KEY(block_number, log_index)
			);
		`);
		this.#queries = {
			upsertValidator: this.db.prepare<ValidatorUpdate, number>(`
				INSERT INTO validators(block_number, log_index, validator, is_registered)
				VALUES(@blockNumber, @logIndex, @validator, @isRegistered)
				ON CONFLICT(block_number, log_index)
				DO NOTHING
			`),
			selectRegisteredValidators: this.db.prepare<FromBlock, Address>(`
				WITH validator_registrations AS (
					SELECT validator
					, is_registered
					, row_number() OVER (
						PARTITION BY validator
						ORDER BY block_number DESC, log_index DESC
					) AS n
					FROM validators
					WHERE block_number < @fromBlock
				)
				SELECT validator
				FROM validator_registrations
				WHERE is_registered = TRUE
				AND n = 1
			`),
			selectValidatorUpdates: this.db.prepare<BlockRange, ValidatorUpdate>(`
				SELECT block_number AS blockNumber
				, log_index AS logIndex
				, validator
				, is_registered AS isRegistered
				FROM validators
				WHERE block_number >= @fromBlock
				AND block_number <= @toBlock
				ORDER BY block_number ASC, log_index ASC
			`),
		};
	}

	protected insertEvent(log: ParsedLog<typeof EVENTS>): void {
		this.#queries.upsertValidator.run({
			blockNumber: log.blockNumber,
			logIndex: log.logIndex,
			validator: log.args.validator,
			isRegistered: log.args.isRegistered ? 1 : 0,
		});
	}

	async validatorSet(period: TimestampRange): Promise<ValidatorSet> {
		const range = await this.blocks.blockRange(period);
		const validators = this.#queries.selectRegisteredValidators.pluck().all(range);
		const updates = this.#queries.selectValidatorUpdates.all(range);

		const set = Object.fromEntries(validators.map((validator) => [validator, [period]]));
		for (const { blockNumber, validator, isRegistered } of updates) {
			const registrations = set[validator] ?? [];
			const previous = registrations.at(-1);
			const timestamp = await this.blocks.mustGetTimestamp({ blockNumber: BigInt(blockNumber) });
			if (isRegistered && (previous === undefined || previous.toTimestamp < timestamp)) {
				registrations.push({
					fromTimestamp: timestamp,
					toTimestamp: period.toTimestamp,
				});
				set[validator] = registrations;
			} else if (!isRegistered && previous !== undefined) {
				previous.toTimestamp = timestamp;
			}
		}

		for (const validator in set) {
			set[validator] = reduceRanges(set[validator]);
		}
		return set;
	}
}
