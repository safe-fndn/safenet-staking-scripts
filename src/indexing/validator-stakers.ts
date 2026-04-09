import type { Statement } from "better-sqlite3";
import { type Address, getAbiItem, zeroAddress } from "viem";
import { CONSENSUS_ABI } from "../abi.js";
import type { TimestampRange } from "../utils/ranges.js";
import { type Configuration, EventIndexer, type Log } from "./events.js";

const EVENTS = [getAbiItem({ abi: CONSENSUS_ABI, name: "ValidatorStakerSet" })];

export type ValidatorStakerPeriod = {
	validator: Address;
} & TimestampRange;

export type ValidatorStaker = {
	staker: Address;
} & TimestampRange;

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
				block_timestamp INTEGER NOT NULL,
				validator TEXT NOT NULL,
				staker TEXT NOT NULL,
				PRIMARY KEY(block_timestamp, validator)
			) WITHOUT ROWID;
		`);
		this.#queries = {
			upsertStaker: this.db.prepare<StakerUpdate, number>(`
				INSERT INTO validator_stakers(block_timestamp, validator, staker)
				VALUES(@blockTimestamp, @validator, @staker)
				ON CONFLICT(block_timestamp, validator)
				DO UPDATE SET staker = EXCLUDED.staker
			`),
			selectStartingStaker: this.db.prepare<StakerRange, Address>(`
				SELECT staker
				FROM validator_stakers
				WHERE block_timestamp < @fromTimestamp
				AND validator = @validator
				ORDER BY block_timestamp DESC
				LIMIT 1
			`),
			selectStakerChanges: this.db.prepare<StakerRange, StakerChange>(`
				SELECT block_timestamp AS blockTimestamp
				, staker
				FROM validator_stakers
				WHERE block_timestamp >= @fromTimestamp
				AND block_timestamp <= @toTimestamp
				AND validator = @validator
				ORDER BY block_timestamp ASC
			`),
		};
	}

	protected insertEvent(log: Log<typeof EVENTS>): void {
		this.#queries.upsertStaker.run({
			blockTimestamp: log.blockTimestamp,
			validator: log.args.validator,
			staker: log.args.staker,
		});
	}

	validatorStakers({ validator, ...period }: ValidatorStakerPeriod): ValidatorStaker[] {
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

		// Account for the fact that a validator may set the staker to different
		// values in the same block, remove stakers with a 0-duration.
		return stakers.filter((s) => s.fromTimestamp < s.toTimestamp);
	}
}
