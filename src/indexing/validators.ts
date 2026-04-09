import type { Statement } from "better-sqlite3";
import { type Address, getAbiItem } from "viem";
import { STAKING_ABI } from "../abi.js";
import { type FromTimestamp, reduceRanges, type TimestampRange } from "../utils/ranges.js";
import { type Configuration, EventIndexer, type Log } from "./events.js";

const EVENTS = [getAbiItem({ abi: STAKING_ABI, name: "ValidatorUpdated" })];

export type ValidatorSet = Record<Address, TimestampRange[]>;

type ValidatorUpdate<I = bigint> = {
	blockTimestamp: I;
	validator: Address;
	isRegistered: 0 | 1;
};

export class Validators extends EventIndexer<typeof EVENTS> {
	#queries: {
		upsertValidator: Statement<ValidatorUpdate, number>;
		selectRegisteredValidators: Statement<FromTimestamp, Address>;
		selectValidatorUpdates: Statement<TimestampRange, ValidatorUpdate<number>>;
	};

	constructor(config: Configuration) {
		super({
			name: "validators",
			events: EVENTS,
			...config,
		});

		this.db.exec(`
			CREATE TABLE IF NOT EXISTS validators(
				block_timestamp INTEGER NOT NULL,
				validator TEXT NOT NULL,
				is_registered INTEGER NOT NULL,
				PRIMARY KEY(block_timestamp, validator)
			) WITHOUT ROWID;
		`);
		this.#queries = {
			upsertValidator: this.db.prepare<ValidatorUpdate, number>(`
				INSERT INTO validators(block_timestamp, validator, is_registered)
				VALUES(@blockTimestamp, @validator, @isRegistered)
				ON CONFLICT(block_timestamp, validator)
				DO UPDATE SET is_registered = EXCLUDED.is_registered
			`),
			selectRegisteredValidators: this.db.prepare<FromTimestamp, Address>(`
				WITH validator_registrations AS (
					SELECT validator
					, is_registered
					, row_number() OVER (
						PARTITION BY validator
						ORDER BY block_timestamp DESC
					) AS n
					FROM validators
					WHERE block_timestamp < @fromTimestamp
				)
				SELECT validator
				FROM validator_registrations
				WHERE is_registered = TRUE
				AND n = 1
			`),
			selectValidatorUpdates: this.db.prepare<TimestampRange, ValidatorUpdate<number>>(`
				SELECT block_timestamp AS blockTimestamp
				, validator
				, is_registered AS isRegistered
				FROM validators
				WHERE block_timestamp >= @fromTimestamp
				AND block_timestamp <= @toTimestamp
				ORDER BY block_timestamp ASC
			`),
		};
	}

	protected insertEvent(log: Log<typeof EVENTS>): void {
		this.#queries.upsertValidator.run({
			blockTimestamp: log.blockTimestamp,
			validator: log.args.validator,
			isRegistered: log.args.isRegistered ? 1 : 0,
		});
	}

	validatorSet(period: TimestampRange): ValidatorSet {
		const validators = this.#queries.selectRegisteredValidators.pluck().all(period);
		const updates = this.#queries.selectValidatorUpdates.all(period);

		const set = Object.fromEntries(validators.map((validator) => [validator, [period]]));
		for (const { blockTimestamp, validator, isRegistered } of updates) {
			const registrations = set[validator] ?? [];
			const previous = registrations.at(-1);
			if (isRegistered && (previous === undefined || previous.toTimestamp < blockTimestamp)) {
				registrations.push({
					fromTimestamp: BigInt(blockTimestamp),
					toTimestamp: period.toTimestamp,
				});
				set[validator] = registrations;
			} else if (!isRegistered && previous !== undefined) {
				previous.toTimestamp = BigInt(blockTimestamp);
			}
		}

		for (const validator in set) {
			set[validator] = reduceRanges(set[validator]);
		}
		return set;
	}
}
