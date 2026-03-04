import type { Database } from "better-sqlite3";
import type { Address } from "viem";
import type { BlockRange, Event, Query, QueryRange } from "./types.js";

// Gets the validator set the is considered for rewards. We consider all validators that are
// registered **at any time** during the payout period. That is, if a validator is added part way
// through the period, we will consider it for rewards.
//
// The query will return a record of validators, and for each validator key in the record an array
// of Staking-chain block ranges where the validator was valid. These will be used to compute
// participation rates for each validator.

export type ValidatorSet = Record<Address, BlockRange[]>;
export type ValidatorSetQuery = Query<Pick<QueryRange, "staking">, ValidatorSet>;

export const validatorSet = ({
	db,
	validatorUpdated,
}: {
	db: Database;
	validatorUpdated: Event;
}): ValidatorSetQuery => {
	const startingRegisteredValidators = db.prepare<{ fromBlock: bigint }, Address>(`
		WITH validator_updates AS (
			SELECT block_number
			, log_index
			, json_extract(args, '$.validator') AS validator
			, json_extract(args, '$.isRegistered') AS is_registered
			FROM ${validatorUpdated.table}
			WHERE block_number < @fromBlock
		)
		, validator_registrations AS (
			SELECT validator
			, is_registered
			, row_number() OVER (PARTITION BY validator ORDER BY block_number DESC, log_index DESC) AS n
			FROM validator_updates
		)
		SELECT validator
		FROM validator_registrations
		WHERE is_registered = TRUE
		AND n = 1
	`);
	const validatorUpdates = db.prepare<
		{ fromBlock: bigint; toBlock: bigint },
		{
			blockNumber: number;
			validator: Address;
			isRegistered: boolean;
		}
	>(`
		SELECT block_number as blockNumber
			, json_extract(args, '$.validator') AS validator
			, json_extract(args, '$.isRegistered') AS isRegistered
		FROM ${validatorUpdated.table}
		WHERE block_number >= @fromBlock
		AND block_number <= @toBlock
		ORDER BY block_number ASC
	`);

	return async (ranges) => {
		const validators = startingRegisteredValidators.pluck().all(ranges.staking);
		const updates = validatorUpdates.all(ranges.staking);

		const set = Object.fromEntries(validators.map((validator) => [validator, [ranges.staking]]));
		for (const { blockNumber, validator, isRegistered } of updates) {
			const registrations = set[validator] ?? [];
			const previous = registrations.at(-1);
			if (isRegistered && (previous === undefined || previous.toBlock < BigInt(blockNumber))) {
				registrations.push({
					fromBlock: BigInt(blockNumber),
					toBlock: ranges.staking.toBlock,
				});
				set[validator] = registrations;
			} else if (!isRegistered && previous !== undefined) {
				previous.toBlock = BigInt(blockNumber);
			}
		}

		return set;
	};
};
