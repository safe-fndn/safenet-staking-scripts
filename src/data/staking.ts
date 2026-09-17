import type { Database, Statement } from "better-sqlite3";
import { type Address, zeroAddress } from "viem";
import { maxBigInt } from "../utils/math.js";
import {
	type FromTimestamp,
	rangeDuration,
	reduceRanges,
	type TimestampRange,
} from "../utils/ranges.js";

export type StakeSelector = {
	staker: Address;
	validator: Address;
};

export type AverageStakeSelector = StakeSelector & TimestampRange;

export type ValidatorSet = Record<Address, TimestampRange[]>;

export type ValidatorStakerPeriod = {
	validator: Address;
} & TimestampRange;

export type ValidatorStaker = {
	staker: Address;
} & TimestampRange;

export type ValidatorStakers = {
	stakers: ValidatorStaker[];
	beneficiary: Address;
};

type LatestStakeRow = {
	blockTimestamp: number;
	amount: string;
};

type StakeChange = StakeSelector & {
	blockTimestamp: bigint;
	amount: string;
};

type StakeAmount = {
	blockTimestamp: number;
	amount: string;
};

type SelectStakeAmounts = StakeSelector & TimestampRange;

type ValidatorUpdate = {
	blockTimestamp: bigint;
	validator: Address;
	isRegistered: 0 | 1;
};

type ValidatorUpdateRow = {
	blockTimestamp: number;
	validator: Address;
	isRegistered: 0 | 1;
};

type StakerUpdate = {
	blockTimestamp: bigint;
	validator: Address;
	staker: Address;
};

type StakerRange = {
	validator: Address;
} & TimestampRange;

type StakerChange = {
	blockTimestamp: number;
	staker: Address;
};

type BeneficiaryUpdate = {
	blockTimestamp: bigint;
	staker: Address;
	beneficiary: Address | null;
};

type BeneficiarySelector = {
	staker: Address;
	toTimestamp: bigint;
};

/**
 * `selectStakeAmounts` and `selectStakers` below exclude sanctioned stakers by
 * reading the `sanctions` table directly, which is owned and created by
 * `SanctionsData` (`src/data/sanctions.ts`). This only works because
 * `Safenet.create` constructs `SanctionsData` before `StakingData`.
 */
export class StakingData {
	#db: Database;
	#queries: {
		selectLatestStake: Statement<StakeSelector, LatestStakeRow>;
		upsertStake: Statement<StakeChange, number>;
		selectStakeAmounts: Statement<SelectStakeAmounts, StakeAmount>;
		selectStakeBlocks: Statement<TimestampRange, number>;
		selectStakers: Statement<TimestampRange, Address>;
		upsertValidator: Statement<ValidatorUpdate, number>;
		selectRegisteredValidators: Statement<FromTimestamp, Address>;
		selectValidatorUpdates: Statement<TimestampRange, ValidatorUpdateRow>;
		upsertStaker: Statement<StakerUpdate, number>;
		selectStartingStaker: Statement<StakerRange, Address>;
		selectStakerChanges: Statement<StakerRange, StakerChange>;
		upsertBeneficiary: Statement<BeneficiaryUpdate, number>;
		selectLatestBeneficiary: Statement<BeneficiarySelector, Address | null>;
	};

	constructor({ db }: { db: Database }) {
		this.#db = db;
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS stake(
				block_timestamp INTEGER NOT NULL,
				staker TEXT NOT NULL,
				validator TEXT NOT NULL,
				amount TEXT NOT NULL,
				PRIMARY KEY(block_timestamp, staker, validator)
			) WITHOUT ROWID;

			CREATE TABLE IF NOT EXISTS validators(
				block_timestamp INTEGER NOT NULL,
				validator TEXT NOT NULL,
				is_registered INTEGER NOT NULL,
				PRIMARY KEY(block_timestamp, validator)
			) WITHOUT ROWID;

			CREATE TABLE IF NOT EXISTS validator_stakers(
				block_timestamp INTEGER NOT NULL,
				validator TEXT NOT NULL,
				staker TEXT NOT NULL,
				PRIMARY KEY(block_timestamp, validator)
			) WITHOUT ROWID;

			CREATE TABLE IF NOT EXISTS staker_beneficiaries(
				block_timestamp INTEGER NOT NULL,
				staker TEXT NOT NULL,
				beneficiary TEXT,
				PRIMARY KEY(block_timestamp, staker)
			) WITHOUT ROWID;
		`);
		this.#queries = {
			selectLatestStake: this.#db.prepare<StakeSelector, LatestStakeRow>(`
				SELECT block_timestamp as blockTimestamp
				, amount
				FROM stake
				WHERE staker = @staker
				AND validator = @validator
				ORDER BY block_timestamp DESC
				LIMIT 1
			`),
			upsertStake: this.#db.prepare<StakeChange, number>(`
				INSERT INTO stake(block_timestamp, staker, validator, amount)
				VALUES(@blockTimestamp, @staker, @validator, @amount)
				ON CONFLICT(block_timestamp, staker, validator)
				DO UPDATE SET amount = EXCLUDED.amount
			`),
			selectStakeAmounts: this.#db.prepare<SelectStakeAmounts, StakeAmount>(`
				WITH is_sanctioned AS (
					SELECT EXISTS (
						SELECT 1
						FROM (
							SELECT sanctioned
							, row_number() OVER (
								PARTITION BY account
								ORDER BY block_timestamp DESC
							) AS n
							FROM sanctions
							WHERE account = @staker
							AND block_timestamp <= @toTimestamp
						)
						WHERE sanctioned = TRUE AND n = 1
					) AS value
				)
				, starting_stake AS (
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
				WHERE NOT (SELECT value FROM is_sanctioned)
				UNION ALL
				SELECT block_timestamp as blockTimestamp
				, amount
				FROM stake
				WHERE block_timestamp >= @fromTimestamp
				AND block_timestamp <= @toTimestamp
				AND staker = @staker
				AND validator = @validator
				AND NOT (SELECT value FROM is_sanctioned)
			`),
			selectStakeBlocks: this.#db.prepare<TimestampRange, number>(`
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
			selectStakers: this.#db.prepare<TimestampRange, Address>(`
				WITH sanctioned AS (
					SELECT account
					FROM (
						SELECT account
						, sanctioned
						, row_number() OVER (
							PARTITION BY account
							ORDER BY block_timestamp DESC
						) AS n
						FROM sanctions
						WHERE block_timestamp <= @toTimestamp
					)
					WHERE sanctioned = TRUE AND n = 1
				)
				, starting_stake AS (
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
				WHERE staker NOT IN (SELECT account FROM sanctioned)
				ORDER BY staker COLLATE NOCASE ASC
			`),
			upsertValidator: this.#db.prepare<ValidatorUpdate, number>(`
				INSERT INTO validators(block_timestamp, validator, is_registered)
				VALUES(@blockTimestamp, @validator, @isRegistered)
				ON CONFLICT(block_timestamp, validator)
				DO UPDATE SET is_registered = EXCLUDED.is_registered
			`),
			selectRegisteredValidators: this.#db.prepare<FromTimestamp, Address>(`
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
			selectValidatorUpdates: this.#db.prepare<TimestampRange, ValidatorUpdateRow>(`
				SELECT block_timestamp AS blockTimestamp
				, validator
				, is_registered AS isRegistered
				FROM validators
				WHERE block_timestamp >= @fromTimestamp
				AND block_timestamp <= @toTimestamp
				ORDER BY block_timestamp ASC
			`),
			upsertStaker: this.#db.prepare<StakerUpdate, number>(`
				INSERT INTO validator_stakers(block_timestamp, validator, staker)
				VALUES(@blockTimestamp, @validator, @staker)
				ON CONFLICT(block_timestamp, validator)
				DO UPDATE SET staker = EXCLUDED.staker
			`),
			selectStartingStaker: this.#db.prepare<StakerRange, Address>(`
				SELECT staker
				FROM validator_stakers
				WHERE block_timestamp < @fromTimestamp
				AND validator = @validator
				ORDER BY block_timestamp DESC
				LIMIT 1
			`),
			selectStakerChanges: this.#db.prepare<StakerRange, StakerChange>(`
				SELECT block_timestamp AS blockTimestamp
				, staker
				FROM validator_stakers
				WHERE block_timestamp >= @fromTimestamp
				AND block_timestamp <= @toTimestamp
				AND validator = @validator
				ORDER BY block_timestamp ASC
			`),
			upsertBeneficiary: this.#db.prepare<BeneficiaryUpdate, number>(`
				INSERT INTO staker_beneficiaries(block_timestamp, staker, beneficiary)
				VALUES(@blockTimestamp, @staker, @beneficiary)
				ON CONFLICT(block_timestamp, staker)
				DO UPDATE SET beneficiary = EXCLUDED.beneficiary
			`),
			selectLatestBeneficiary: this.#db.prepare<BeneficiarySelector, Address | null>(`
				SELECT beneficiary
				FROM staker_beneficiaries
				WHERE staker = @staker
				AND block_timestamp <= @toTimestamp
				ORDER BY block_timestamp DESC
				LIMIT 1
			`),
		};
	}

	get db() {
		return this.#db;
	}

	latestStake(selector: StakeSelector): LatestStakeRow | undefined {
		return this.#queries.selectLatestStake.get(selector);
	}

	registerStakeChange(change: StakeChange): void {
		this.#queries.upsertStake.run(change);
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

	registerValidatorUpdate({ blockTimestamp, validator, isRegistered }: ValidatorUpdate): void {
		this.#queries.upsertValidator.run({ blockTimestamp, validator, isRegistered });
	}

	validatorSet(period: TimestampRange): ValidatorSet {
		const validators = this.#queries.selectRegisteredValidators.pluck().all(period);
		const updates = this.#queries.selectValidatorUpdates.all(period);

		const set = Object.fromEntries(validators.map((validator) => [validator, [{ ...period }]]));
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

	registerStakerUpdate({ blockTimestamp, validator, staker }: StakerUpdate): void {
		this.#queries.upsertStaker.run({ blockTimestamp, validator, staker });
	}

	registerBeneficiaryUpdate({ blockTimestamp, staker, beneficiary }: BeneficiaryUpdate): void {
		this.#queries.upsertBeneficiary.run({ blockTimestamp, staker, beneficiary });
	}

	validatorStakers({ validator, ...period }: ValidatorStakerPeriod): ValidatorStakers {
		const staker = this.#queries.selectStartingStaker.pluck().get({ validator, ...period });
		const changes = this.#queries.selectStakerChanges.all({ validator, ...period });

		const stakers = [
			{
				staker: staker ?? zeroAddress,
				...period,
			},
		];
		for (const { blockTimestamp, staker } of changes) {
			const previous = stakers.at(-1);
			if (previous === undefined) {
				throw new Error("stakers is never empty");
			}

			// Account for the fact that a validator may call set their staker
			// to the same address multiple times.
			if (previous.staker === staker) {
				continue;
			}

			const timestamp = BigInt(blockTimestamp);
			previous.toTimestamp = timestamp;
			stakers.push({
				staker,
				...period,
				fromTimestamp: timestamp,
			});
		}

		const last = stakers.at(-1);
		const beneficiary =
			last !== undefined
				? (this.#queries.selectLatestBeneficiary
						.pluck()
						.get({ staker: last.staker, toTimestamp: period.toTimestamp }) ?? last.staker)
				: zeroAddress;

		return { stakers, beneficiary };
	}
}
