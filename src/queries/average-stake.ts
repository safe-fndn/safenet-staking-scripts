import type { Database } from "better-sqlite3";
import type { Blocks, EventTable } from "./types.js";

export const averageStake = async ({
	db, stakeIncreased, withdrawalInitiated,
}: {
	db: Database;
	stakingBlocks: Blocks;
	stakeIncreased: EventTable;
	withdrawalInitiated: EventTable;
}) => {
	const startingBalances = db.prepare(`
		WITH added AS (
			SELECT json_extract(args, '$.staker') AS staker
			, json_extract(args, '$.validator') AS validator
			, decimal_sum(json_extract(args, '$.amount')) AS amount
			FROM ${stakeIncreased.table}
			WHERE block_number < @fromBlock
			GROUP BY staker, validator
		)
		, removed AS (
			SELECT json_extract(args, '$.staker') AS staker
			, json_extract(args, '$.validator') AS validator
			, decimal_sum(json_extract(args, '$.amount')) AS amount
			FROM ${withdrawalInitiated.table}
			WHERE block_number < @fromBlock
			GROUP BY staker, validator
		)
		SELECT added.staker
		, added.validator
		, decimal_sub(added.amount, COALESCE(removed.amount, 0)) AS balance
		FROM added
		LEFT JOIN removed
		ON added.staker = removed.staker
		AND added.validator = removed.validator
   		WHERE decimal_cmp(balance, 0) > 0
	`);
	const balanceChanges = db.prepare(`
		WITH added AS (
			SELECT block_number
			, log_index
			, json_extract(args, '$.staker') AS staker
			, json_extract(args, '$.validator') AS validator
			, decimal_sum(json_extract(args, '$.amount')) AS amount
			FROM ${stakeIncreased.table}
		)
		, removed AS (
			SELECT block_number
			, log_index
			, json_extract(args, '$.staker') AS staker
			, json_extract(args, '$.validator') AS validator
			, decimal_sum(json_extract(args, '$.amount')) AS amount
			FROM ${withdrawalInitiated.table}
		)
		SELECT COALESCE(added.staker, removed.staker)
		, COALESCE(added.validator, removed.validator)
		, decimal_sub(COALESCE(removed.amount, 0), COALESCE(removed.amount, 0)) AS amount
		FROM added
		FULL JOIN removed
		ON added.block_number = removed.block_number
		AND added.log_index = removed.log_index
		WHERE block_number >= @blockNumber
		AND block_number <= @toBlock
	`);
}
