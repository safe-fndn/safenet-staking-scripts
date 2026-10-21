import { createClient, custom, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { backoff } from "./backoff.js";
import { blockAtTimestamp } from "./blocks.js";

// A chain with blocks `0..=latest`, where block `n` has `timestampOf(n)`,
// counting the blocks it serves.
const fakeChain = (latest: number, timestampOf: (n: number) => bigint) => {
	const chain = { requests: 0 };
	const client = createClient({
		transport: custom({
			async request({ method, params }) {
				if (method !== "eth_getBlockByNumber") {
					throw new Error(`unsupported JSON-RPC method "${method}"`);
				}
				chain.requests++;
				const [tag] = params as [string, boolean];
				const n = tag === "latest" ? latest : Number(BigInt(tag));
				return n <= latest ? { number: toHex(n), timestamp: toHex(timestampOf(n)) } : null;
			},
		}),
	});
	return { client, requests: () => chain.requests };
};
const chainOf = (timestamps: bigint[]) =>
	fakeChain(timestamps.length - 1, (n) => timestamps[n] ?? 0n);

// Failed requests are not retried.
const noBackoff = backoff({ delays: [] });

// Blocks 0..=9 at 100, 105, …, 145.
const regular = Array.from({ length: 10 }, (_, i) => 100n + 5n * BigInt(i));

describe("blockAtTimestamp", () => {
	it("returns the block exactly at a timestamp", async () => {
		const { client } = chainOf(regular);
		for (const [number, timestamp] of regular.entries()) {
			expect(await blockAtTimestamp(client, { timestamp }, noBackoff)).toEqual({
				number: BigInt(number),
				timestamp,
			});
		}
	});

	it("returns the last block before a timestamp between blocks", async () => {
		const { client } = chainOf(regular);
		for (const [number, timestamp] of regular.slice(0, -1).entries()) {
			for (const offset of [1n, 4n]) {
				expect(
					await blockAtTimestamp(client, { timestamp: timestamp + offset }, noBackoff),
				).toEqual({ number: BigInt(number), timestamp });
			}
		}
	});

	it("returns null before the first block", async () => {
		const { client } = chainOf(regular);
		expect(await blockAtTimestamp(client, { timestamp: 99n }, noBackoff)).toBeNull();
		expect(await blockAtTimestamp(client, { timestamp: 0n }, noBackoff)).toBeNull();
	});

	it("does not search before the starting block", async () => {
		const { client } = chainOf(regular);
		expect(
			await blockAtTimestamp(client, { timestamp: 119n, fromBlock: 4n }, noBackoff),
		).toBeNull();
		expect(await blockAtTimestamp(client, { timestamp: 120n, fromBlock: 4n }, noBackoff)).toEqual({
			number: 4n,
			timestamp: 120n,
		});
		expect(await blockAtTimestamp(client, { timestamp: 132n, fromBlock: 4n }, noBackoff)).toEqual({
			number: 6n,
			timestamp: 130n,
		});
	});

	it("throws after the latest block", async () => {
		const { client } = chainOf(regular);
		await expect(blockAtTimestamp(client, { timestamp: 146n }, noBackoff)).rejects.toThrow(
			"timestamp 146 is after the latest block",
		);
	});

	it("returns the last of several blocks with equal timestamps", async () => {
		// Blocks 0..=7, with blocks 2..=5 sharing a timestamp.
		const { client } = chainOf([10n, 20n, 30n, 30n, 30n, 30n, 40n, 40n]);
		const at = (timestamp: bigint) => blockAtTimestamp(client, { timestamp }, noBackoff);
		expect(await at(20n)).toEqual({ number: 1n, timestamp: 20n });
		expect(await at(29n)).toEqual({ number: 1n, timestamp: 20n });
		expect(await at(30n)).toEqual({ number: 5n, timestamp: 30n });
		expect(await at(35n)).toEqual({ number: 5n, timestamp: 30n });
		expect(await at(40n)).toEqual({ number: 7n, timestamp: 40n });
	});

	it("takes a logarithmic number of block requests", async () => {
		// One block per 5 seconds, roughly a year of Gnosis Chain.
		const chain = fakeChain(6_000_000, (n) => 5n * BigInt(n));
		expect(await blockAtTimestamp(chain.client, { timestamp: 12_345_678n }, noBackoff)).toEqual({
			number: 2_469_135n,
			timestamp: 12_345_675n,
		});
		// latest, `fromBlock` and ⌈log2(6,000,000)⌉ = 23 bisections.
		expect(chain.requests()).toBeLessThanOrEqual(25);
	});
});
