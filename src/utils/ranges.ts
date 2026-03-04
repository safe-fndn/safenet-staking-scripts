import { maxBigInt } from "./math.js";

export type BlockRange = {
	fromBlock: bigint;
	toBlock: bigint;
};
export type FromBlock = Pick<BlockRange, "fromBlock">;
export type ToBlock = Pick<BlockRange, "toBlock">;

export type TimestampRange = {
	fromTimestamp: bigint;
	toTimestamp: bigint;
};
export type FromTimestamp = Pick<TimestampRange, "fromTimestamp">;
export type ToTimestamp = Pick<TimestampRange, "toTimestamp">;

export type Range = BlockRange | TimestampRange;

const isBlockRange = (r: Range): r is BlockRange => {
	return "fromBlock" in r;
};

const startOf = (r: Range): bigint => (isBlockRange(r) ? r.fromBlock : r.fromTimestamp);
const endOf = (r: Range): bigint => (isBlockRange(r) ? r.toBlock : r.toTimestamp);
const boundsOf = (r: Range): [bigint, bigint] =>
	isBlockRange(r) ? [r.fromBlock, r.toBlock] : [r.fromTimestamp, r.toTimestamp];
const setEnd = (r: Range, end: bigint) => {
	if (isBlockRange(r)) {
		r.toBlock = end;
	} else {
		r.toTimestamp = end;
	}
};

/**
 * Reduces input ranges of the input to the smallest possible list representing
 * the same range set. The output is always sorted.
 */
export const reduceRanges = <T extends Range>(ranges: readonly T[]): T[] => {
	const sorted = [...ranges].sort((a, b) => (startOf(a) < startOf(b) ? -1 : 1));
	const islands: T[] = [];
	for (const range of sorted) {
		const [start, end] = boundsOf(range);
		const last = islands.at(-1);
		if (last !== undefined && endOf(last) + 1n >= start) {
			setEnd(last, maxBigInt(endOf(last), end));
		} else {
			islands.push(range);
		}
	}
	return islands;
};

/**
 * Formats a timestamp.
 */
export const formatTimestamp = (timestamp: bigint): string =>
	new Date(Number(timestamp) * 1000).toISOString();

/**
 * Formats a timestamp or block range.
 */
export const formatRange = (range: Range): string =>
	isBlockRange(range)
		? `${range.fromBlock}-${range.toBlock}`
		: `${formatTimestamp(range.fromTimestamp)}-${formatTimestamp(range.toTimestamp)}`;
