import { maxBigInt, minBigInt } from "./math.js";

export type BlockRange = {
	fromBlock: bigint;
	toBlock: bigint;
};

/**
 * Reduces input ranges of the input to the smallest possible list representing
 * the same range set. The output is always sorted.
 */
export const reduceRanges = (ranges: readonly BlockRange[]): BlockRange[] => {
	const sorted = [...ranges].sort(({ fromBlock: a }, { fromBlock: b }) => (a < b ? -1 : 1));
	const islands: BlockRange[] = [];
	for (const { fromBlock, toBlock } of sorted) {
		const last = islands.at(-1);
		if (last !== undefined && last.toBlock + 1n >= fromBlock) {
			last.toBlock = maxBigInt(last.toBlock, toBlock);
		} else {
			islands.push({ fromBlock, toBlock });
		}
	}
	return islands;
};

export type PagedBlockRange = BlockRange & {
	blockPageSize: bigint;
};

/**
 * Takes the next page from a range set. Returns `null` if the specified range
 * is completely included in the set.
 */
export const nextPage = (
	{ fromBlock, toBlock, blockPageSize }: PagedBlockRange,
	ranges: readonly BlockRange[],
): BlockRange | null => {
	// Reduce the ranges, this gives us a sorted array of ranges with absolutely
	// no overlapping items. This means that given any to consecutive items, we
	// have the property that the range from `reduced[i].toBlock + 1n` to
	// `reduced[i + 1].fromBlock - 1n` is a gap in our set of ranges. We try to
	// find the gap which includes the paged block range we are looking for.
	const reduced = reduceRanges(ranges);

	// TODO: This can be done more efficiently with a binary search. Since we
	// expect the number of items in `ranges` to be fairly small, just search
	// linearly through it for now.
	let previous = { fromBlock: -1n, toBlock: fromBlock - 1n };
	let next = { fromBlock: toBlock + 1n, toBlock: -1n };
	for (const range of reduced) {
		if (range.fromBlock > fromBlock) {
			next = range;
			break;
		}
		previous = range;
	}

	// At this point, `previous` and `next` are the first two consecutive items
	// which include the paged block range we are looking for. Compute the gap
	// and cap the number of items to `blockPageSize` (noting that block ranges
	// are inclusive).
	const gap = {
		fromBlock: maxBigInt(fromBlock, previous.toBlock + 1n),
		toBlock: minBigInt(toBlock, next.fromBlock - 1n),
	};
	gap.toBlock = minBigInt(gap.toBlock, gap.fromBlock + blockPageSize - 1n);

	// Make sure we have a non-empty range.
	if (gap.fromBlock > gap.toBlock) {
		return null;
	}

	return gap;
};
