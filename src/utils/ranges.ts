import { maxBigInt } from "./math.js";

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

/**
 * Formats a timestamp or block range.
 */
export const formatRange = (range: BlockRange): string => `${range.fromBlock}-${range.toBlock}`;
