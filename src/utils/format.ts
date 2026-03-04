import { formatUnits } from "viem";

/**
 * Formats a timestamp.
 */
export const formatTimestamp = (timestamp: bigint): string =>
	new Date(Number(timestamp) * 1000).toISOString();

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
