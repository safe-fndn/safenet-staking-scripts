import path from "node:path";
import util, { type ParseArgsOptionsConfig } from "node:util";
import debug from "debug";
import { configDotenv } from "dotenv";
import { type Client, createClient, getAddress, http, type Prettify } from "viem";
import { z } from "zod";
import { type MerkleDb, nextRewardsStart } from "../merkledb/index.js";
import { dateToTimestamp, type TimestampRange } from "../utils/ranges.js";
import { zGitHubRepository } from "./gh.js";
import {
	AEGIS_REWARDS_START,
	AEGIS_VALIDATOR_REWARDS,
	AEGIS_VALIDATOR_REWARDS_DURATION,
	BETA_REWARDS_UNTIL,
	BETA_TOKEN_TOTAL,
	SENTINEL_REWARDS_PER_YEAR,
	SENTINEL_REWARDS_YEAR,
} from "./sep.js";

const SCHEMA = z.object({
	databaseFile: z.string().min(1),
	stakingRpcUrl: z.url(),
	stakingBlockPageSize: z.coerce.bigint(),
	stakingAddress: z.string().transform((a) => getAddress(a)),
	stakingStartBlock: z.coerce.bigint(),
	delegateRegistryAddress: z.string().transform((a) => getAddress(a)),
	delegateRegistryStartBlock: z.coerce.bigint().optional(),
	sanctionsListAddress: z.string().transform((a) => getAddress(a)),
	sanctionsListStartBlock: z.coerce.bigint(),
	sanctionsAddressRepo: zGitHubRepository.optional(),
	consensusRpcUrl: z.url(),
	consensusAddress: z.string().transform((a) => getAddress(a)),
	consensusStartBlock: z.coerce.bigint(),
	consensusBlockPageSize: z.coerce.bigint(),
	sentinelOracleAddress: z.string().transform((a) => getAddress(a)),
	sentinelOracleStartBlock: z.coerce.bigint(),
	tsv: z.boolean().optional(),
});

const envKey = (key: string): string => {
	// We standardize all of our environment variables to use SCREAMING_SNAKE_CASE inflection of
	// their camelCase counterparts.
	return key.replace(/([A-Z])/g, "_$1").toUpperCase();
};

const isBool = <Z extends z.ZodType>(field: Z): boolean => {
	// Heuristically determine whether a field represents a boolean value.
	return field.safeParse(true).data === true;
};

const envToBool = (s: string | undefined): boolean | undefined => {
	if ((s ?? "") === "") {
		return undefined;
	} else if (s === "0" || s === "false") {
		return false;
	} else if (s === "1" || s === "true") {
		return true;
	} else {
		throw new Error(`invalid boolean value ${s}`);
	}
};

export type ArgsInfer<T> = T extends z.core.$ZodLooseShape
	? z.infer<ReturnType<typeof SCHEMA.extend<T>>>
	: z.infer<typeof SCHEMA>;

export type Args<T = undefined> = Prettify<
	ArgsInfer<T> & {
		stakingClient: Client;
		consensusClient: Client;
	}
>;

export function parseArgs(extraArgs?: undefined): Args;
export function parseArgs<T extends z.core.$ZodLooseShape>(extraArgs: T): Args<T>;
export function parseArgs<T extends z.core.$ZodLooseShape>(extraArgs: T | undefined) {
	const schema = extraArgs === undefined ? SCHEMA : SCHEMA.extend(extraArgs);

	const options = {} as ParseArgsOptionsConfig;
	let allowPositionals = false;
	for (const [key, field] of Object.entries(schema.shape)) {
		if (key === "positionals") {
			allowPositionals = true;
		} else {
			options[key] = isBool(field)
				? { type: "boolean", default: envToBool(process.env[envKey(key)]) }
				: { type: "string", default: process.env[envKey(key)] };
		}
	}

	const { values, positionals } = util.parseArgs({ options, allowPositionals });
	const args = allowPositionals ? schema.parse({ ...values, positionals }) : schema.parse(values);

	return {
		...args,
		stakingClient: createClient({ transport: http(args.stakingRpcUrl) }),
		consensusClient: createClient({ transport: http(args.consensusRpcUrl) }),
	};
}

export function main(run: (args: Args) => Promise<void>): void;
export function main<T extends z.core.$ZodLooseShape>(
	extraArgs: T,
	run: (args: Args<T>) => Promise<void>,
): void;
export function main<T extends z.core.$ZodLooseShape>(
	...params: [(args: Args) => Promise<void>] | [T, (args: Args<T>) => Promise<void>]
): void {
	configDotenv({ quiet: true });

	// `debug` eagerly enables itself when the package is first loaded, and before we load our
	// `.env` config. Manually enable debug after reading configuring our environment in order to
	// ensure it also respects the value in the `.env` file.
	if (process.env.DEBUG) {
		debug.enable(process.env.DEBUG);
	}

	let promise: Promise<void>;
	if (typeof params[0] === "function") {
		const [run] = params;
		const args = parseArgs();
		promise = run(args);
	} else {
		const [extraArgs, run] = params;
		if (run === undefined) {
			throw new Error("unspecified run function");
		}
		const args = parseArgs(extraArgs);
		promise = run(args);
	}
	promise.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	});
}

export const rewardsPeriod = (period: {
	rewardPeriodStart?: bigint;
	rewardPeriodEnd?: bigint;
}): TimestampRange => {
	// As per the Safenet Aegis SEP, rewards are payed out every two weeks
	// starting from October 13th, 2026. Therefore, if no rewards period is
	// specified take the last two week period ending on the very start of the
	// last Tuesday. This just makes it easier to run rewards scripts, as not
	// manually specifying a rewards period will Do The Right Thing™.
	const TWO_WEEKS = BigInt(60 * 60 * 24 * 7 * 2);
	const lastTuesday = () => {
		const now = new Date();
		// Day '2' is Tuesday, so we get just subtract the day of the week from
		// the date (i.e. the day of the month) and either add 2 or subtract 5
		// to get the date of the last Tuesday depending on whether not the
		// current day comes before or after Tuesday (noting that the Date
		// functions support negative dates to roll back months).
		const sundayDate = now.getUTCDate() - now.getUTCDay();
		const tuesday = Date.UTC(
			now.getUTCFullYear(),
			now.getUTCMonth(),
			now.getUTCDay() >= 2 ? sundayDate + 2 : sundayDate - 5,
		);
		return BigInt(tuesday / 1000);
	};

	const toTimestamp =
		period.rewardPeriodEnd ??
		(period.rewardPeriodStart !== undefined ? period.rewardPeriodStart + TWO_WEEKS : lastTuesday());
	const fromTimestamp = period.rewardPeriodStart ?? toTimestamp - TWO_WEEKS;
	return { fromTimestamp, toTimestamp };
};

/**
 * Returns the rewards directory of a `--record` root, which is where its `MerkleDb` lives.
 */
export const recordRewardsDirectory = (record: string): string =>
	path.join(record, "assets", "rewards");

export const totalRewardsAmount = async (
	args: {
		rewardPeriodStart?: bigint;
		rewardPeriodEnd?: bigint;
		totalRewards?: bigint;
	},
	db?: MerkleDb,
): Promise<bigint> => {
	if (args.totalRewards !== undefined) {
		return args.totalRewards;
	}

	// As per the Safenet Aegis SEP, a total of 5M SAFE tokens are
	// distributed evenly over 52 weeks of rewards starting on October 13th,
	// 2026. The amount for a given period is therefore prorated by its duration
	// (which is not guaranteed to be exactly two weeks). When a record's
	// `MerkleDb` is provided, we account for what has already been distributed:
	// this both absorbs the rounding remainder into the final periods and rolls
	// past unpaid amounts forward into future periods (since `tokenTotal` only
	// tracks committed payouts, not the carried-over `unpaidAmount`).
	//
	// Sentinel rewards ride the same Merkle distribution, so they are included
	// in `tokenTotal` and must be discounted here - otherwise the validator
	// program would be under-funded by exactly the accumulated sentinel spend.
	//
	// The record also includes everything paid out during Beta, which is not
	// part of the Aegis budget and is discounted as well. Beta's leftover
	// `unpaidAmount` is deliberately not carried forward into Aegis.

	const period = rewardsPeriod(args);
	const periodDuration = period.toTimestamp - period.fromTimestamp;

	if (db === undefined) {
		return (AEGIS_VALIDATOR_REWARDS * periodDuration) / AEGIS_VALIDATOR_REWARDS_DURATION;
	}

	// Aegis rewards are always recorded on top of the rewards DB pinned at the
	// end of Beta, so a record from before then is not an Aegis record.
	const index = await db.index();
	if (
		index?.rewardsUntil === undefined ||
		dateToTimestamp(index.rewardsUntil) < BETA_REWARDS_UNTIL
	) {
		throw new Error("record is not caught up to the end of Beta");
	}
	const rewardsUntil = dateToTimestamp(index.rewardsUntil);

	// Measure the elapsed time from the start of the period following the
	// record, so that a record ending with Beta has paid nothing of Aegis yet.
	const paidRewardsDuration = nextRewardsStart(rewardsUntil) - AEGIS_REWARDS_START;
	if (paidRewardsDuration >= AEGIS_VALIDATOR_REWARDS_DURATION) {
		return 0n;
	}

	const newTokenTotal =
		(AEGIS_VALIDATOR_REWARDS * (paidRewardsDuration + periodDuration)) /
		AEGIS_VALIDATOR_REWARDS_DURATION;
	return newTokenTotal - (index.tokenTotal - index.sentinelTokenTotal - BETA_TOKEN_TOTAL);
};

export const sentinelRewardsAmount = (args: {
	rewardPeriodStart?: bigint;
	rewardPeriodEnd?: bigint;
	sentinelRewards?: bigint;
}): bigint => {
	if (args.sentinelRewards !== undefined) {
		return args.sentinelRewards;
	}

	// As per the Safenet Aegis SEP, each sentinel is granted 400,000 SAFE tokens per
	// year of service, prorated by the duration of the payout period. Unlike
	// `totalRewardsAmount` above, there is deliberately no reconciliation
	// against what has already been distributed: the spend of a period depends
	// on how many sentinels were eligible in it, so a cumulative "distributed
	// so far" catch-up is not well defined. The aggregate spend is instead
	// bounded upstream by the sentinel allowlist on the oracle contract.

	const period = rewardsPeriod(args);
	const periodDuration = period.toTimestamp - period.fromTimestamp;

	return (SENTINEL_REWARDS_PER_YEAR * periodDuration) / SENTINEL_REWARDS_YEAR;
};
