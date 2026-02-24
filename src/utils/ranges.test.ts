import { describe, expect, it } from "vitest";
import { nextPage, reduceRanges } from "./ranges.js";

const r = ([f, t]: readonly [number | bigint, number | bigint]) => ({
	fromBlock: BigInt(f),
	toBlock: BigInt(t),
});
const rs = (args: readonly (readonly [number | bigint, number | bigint])[]) => args.map(r);

describe("reduceRanges", () => {
	it.concurrent("should reduce and sort ranges", () => {
		const reduced = reduceRanges(
			rs([
				[42, 1337],
				[2, 4],
				[1, 6],
				[8, 10],
				[12, 15],
				[9, 12],
				[24, 26],
				[22, 23],
			]),
		);
		expect(reduced).toEqual(
			rs([
				[1, 6],
				[8, 15],
				[22, 26],
				[42, 1337],
			]),
		);
	});
});

describe("nextPage", () => {
	it.concurrent("should get the first page for empty ranges", () => {
		const page = nextPage(
			{
				fromBlock: 0n,
				toBlock: 10n,
				blockPageSize: 2n,
			},
			[],
		);
		expect(page).toEqual({
			fromBlock: 0n,
			// Note that the ranges are inclusive, here we would fetch blocks 1
			// and 2, for a page size of 2 (as expected).
			toBlock: 1n,
		});
	});

	it.concurrent("should return null if there are no ranges", () => {
		const range = {
			fromBlock: 100n,
			toBlock: 199n,
			blockPageSize: 10n,
		};
		for (const ranges of [
			[[100, 199]],
			[[0, 1000]],
			[
				[100, 150],
				[150, 199],
			],
		] as const) {
			const page = nextPage(range, rs(ranges));
			expect(page).toBeNull();
		}
	});

	it.concurrent("should get the first page for empty ranges", () => {
		const range = {
			fromBlock: 100n,
			toBlock: 199n,
			blockPageSize: 10n,
		};
		for (const [ranges, expected] of [
			// Start hasn't been indexed
			[[[150, 175]], [100, 109]],
			[[[103, 199]], [100, 102]],
			// End hasn't been indexed
			[[[100, 179]], [180, 189]],
			[[[100, 195]], [196, 199]],
			// Middle hasn't been indexed
			[
				[
					[0, 110],
					[150, 170],
					[190, 1000],
				],
				[111, 120],
			],
			[
				[
					[100, 150],
					[152, 199],
				],
				[151, 151],
			],
		] as const) {
			const page = nextPage(range, rs(ranges));
			expect(page).toEqual(r(expected));
		}
	});
});
