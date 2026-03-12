import { formatUnits } from "viem";
import { isBlockRange, type Range, timestampToDate } from "./ranges.js";

/**
 * Formats a timestamp.
 */
export const formatTimestamp = (timestamp: bigint): string =>
	timestampToDate(timestamp).toISOString();

/**
 * Formats a timestamp or block range.
 */
export const formatRange = (range: Range): string =>
	isBlockRange(range)
		? `${range.fromBlock}-${range.toBlock}`
		: `${formatTimestamp(range.fromTimestamp)}-${formatTimestamp(range.toTimestamp)}`;

/**
 * Formats a SAFE token amount.
 */
export const formatSafeToken = (amount: bigint): string => {
	const formatted = formatUnits(amount, 18);
	const [int, frac] = formatted.split(".");

	// We pad the integer parts to account for the 1.000.000.000 total supply of
	// SAFE, and the fractional part for 18 decimal places.
	return `${int.padStart(10)}.${(frac ?? "0").padEnd(18)}`;
};

/**
 * Formats a rate as a percentage.
 */
export const formatPercent = (rate: number): string => `${(rate * 100).toFixed(2)}%`;
