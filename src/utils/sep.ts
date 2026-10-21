/**
 * Safenet rewards program constants.
 *
 * These allocations and schedules were set by the SafeDAO in Safe Ecosystem Proposals (SEPs), and
 * changing any of them changes the rewards that are distributed.
 */

/**
 * The end of the last Beta rewards period.
 */
export const BETA_REWARDS_UNTIL = BigInt(Date.UTC(2026, 9, 6) / 1000);

/**
 * The start of the Aegis rewards program, one week after the last Beta rewards period ended. No
 * rewards are paid for the week in between.
 */
export const AEGIS_REWARDS_START = BigInt(Date.UTC(2026, 9, 13) / 1000);
