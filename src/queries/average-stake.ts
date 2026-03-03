import type { Database } from "better-sqlite3";
import type { BlockRange, Blocks, Event } from "./types.js";

export const averageStake = ({
	db,
	stakeIncreased,
	withdrawalInitiated,
}: {
	db: Database;
	stakingBlocks: Blocks;
	stakeIncreased: Event;
	withdrawalInitiated: Event;
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
			, json_extract(args, '$.amount') AS amount
			FROM ${stakeIncreased.table}
			WHERE block_number >= @blockNumber
			AND block_number <= @toBlock
			AND json_extract(args, '$.staker') = @staker
			AND json_extract(args, '$.validator') = @validator
		)
		, removed AS (
			SELECT block_number
			, json_extract(args, '$.amount') AS amount
			FROM ${withdrawalInitiated.table}
			WHERE block_number >= @blockNumber
			AND block_number <= @toBlock
			AND json_extract(args, '$.staker') = @staker
			AND json_extract(args, '$.validator') = @validator
		)
		SELECT COALESCE(added.block_number, removed.block_number) AS blockNumber
		, decimal_sub(COALESCE(added.amount, 0), COALESCE(removed.amount, 0)) AS amount
		FROM added
		FULL JOIN removed
		ON 1 = 0
	`);

	return async function* (range: BlockRange) {
		console.log(startingBalances, balanceChanges, range);
		yield 1;
		throw new Error("not implemented");
	};
};
