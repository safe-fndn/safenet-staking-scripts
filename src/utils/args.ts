import util, { type ParseArgsOptionsConfig } from "node:util";
import debug from "debug";
import { configDotenv } from "dotenv";
import { type Client, createClient, getAddress, http, type Prettify } from "viem";
import { z } from "zod";
import type { TimestampRange } from "../utils/ranges.js";

const SCHEMA = z.object({
	databaseFile: z.string().min(1),
	stakingRpcUrl: z.url(),
	stakingBlockPageSize: z.coerce.bigint(),
	stakingAddress: z.string().transform((a) => getAddress(a)),
	stakingStartBlock: z.coerce.bigint(),
	sanctionsListAddress: z.string().transform((a) => getAddress(a)),
	sanctionsListStartBlock: z.coerce.bigint(),
	consensusRpcUrl: z.url(),
	consensusAddress: z.string().transform((a) => getAddress(a)),
	consensusStartBlock: z.coerce.bigint(),
	consensusBlockPageSize: z.coerce.bigint(),
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
	for (const [key, field] of Object.entries(schema.shape)) {
		options[key] = isBool(field)
			? { type: "boolean", default: envToBool(process.env[envKey(key)]) }
			: { type: "string", default: process.env[envKey(key)] };
	}

	const { values } = util.parseArgs({ options });
	const args = schema.parse(values);

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
	// As per the DAO proposal, rewards are payed out every two weeks from
	// starting from April 7th, 2026. Therefore, if no rewards period is
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
