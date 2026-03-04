import { describe, expect, it } from "vitest";
import { reduceRanges } from "./ranges.js";

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
