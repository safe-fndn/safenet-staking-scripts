/**
 * Safenet rewards program constants.
 *
 * These allocations and schedules were set by the SafeDAO in Safe Ecosystem Proposals (SEPs), and
 * changing any of them changes the rewards that are distributed.
 */

import { parseUnits } from "viem";

const WEEK = BigInt(60 * 60 * 24 * 7);

/**
 * The end of the last Beta rewards period.
 */
export const BETA_REWARDS_UNTIL = BigInt(Date.UTC(2026, 9, 6) / 1000);

/**
 * The start of the Aegis rewards program, one week after the last Beta rewards period ended. No
 * rewards are paid for the week in between.
 */
export const AEGIS_REWARDS_START = BigInt(Date.UTC(2026, 9, 13) / 1000);

/**
 * The shared duration of the Aegis validator and sentinel rewards allocations.
 */
export const AEGIS_REWARDS_DURATION = 52n * WEEK;

/**
 * The shared payout period for Aegis validator and sentinel rewards.
 */
export const AEGIS_REWARDS_PERIOD = 2n * WEEK;

/**
 * The validator rewards budget of the Aegis program, distributed evenly over its duration.
 */
export const AEGIS_VALIDATOR_REWARDS = parseUnits("5000000.0", 18);

/**
 * The `tokenTotal` of the rewards DB pinned at the end of Beta, which had no sentinel spend. None
 * of it is part of the Aegis validator budget, so it is discounted when catching up to what Aegis
 * has distributed so far.
 */
export const BETA_TOKEN_TOTAL = 4499987774807670271201970n;

/**
 * The grant to each eligible sentinel over the Aegis rewards duration.
 */
export const AEGIS_SENTINEL_REWARDS = parseUnits("400000.0", 18);
