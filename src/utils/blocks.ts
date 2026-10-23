import debug from "debug";
import type { Client } from "viem";
import { getBlock } from "viem/actions";
import type { BlockTimestamp } from "../indexing/events.js";
import { type Backoff, backoff } from "./backoff.js";

/**
 * Thrown when a timestamp is later than the latest block, so that the block at it is not known
 * yet.
 */
export class TimestampAfterLatestBlockError extends Error {
	constructor(timestamp: bigint) {
		super(`timestamp ${timestamp} is after the latest block`);
		this.name = "TimestampAfterLatestBlockError";
	}
}

/**
 * Returns the last block with `timestamp ≤ t`, searching no earlier than
 * `fromBlock` (default: genesis).
 *
 * Block timestamps only need to be non-decreasing: when consecutive blocks
 * share a timestamp, the last of them is returned. Returns `null` when the
 * `fromBlock` block is already later than `t`, and throws when `t` is later
 * than the latest block, since a block with `timestamp ≤ t` may still be
 * produced.
 */
export const blockAtTimestamp = async (
	client: Client,
	{ timestamp, fromBlock = 0n }: { timestamp: bigint; fromBlock?: bigint },
	withBackoff: Backoff = backoff({ debug: debug("safenet:blocks") }),
): Promise<BlockTimestamp | null> => {
	const block = async (query: Parameters<typeof getBlock>[1]): Promise<BlockTimestamp> => {
		const { number, timestamp } = await withBackoff(() => getBlock(client, query));
		if (number === null) {
			throw new Error("unexpected pending block");
		}
		return { number, timestamp };
	};

	const latest = await block({ blockTag: "latest" });
	if (timestamp > latest.timestamp) {
		throw new TimestampAfterLatestBlockError(timestamp);
	}
	if (timestamp === latest.timestamp) {
		return latest;
	}

	let lo = await block({ blockNumber: fromBlock });
	if (lo.timestamp > timestamp) {
		return null;
	}

	// Invariant: `lo.timestamp ≤ t < hi.timestamp`, so the answer is `lo` once
	// the two blocks are adjacent.
	let hi = latest;
	while (hi.number - lo.number > 1n) {
		const mid = await block({ blockNumber: (lo.number + hi.number) / 2n });
		if (mid.timestamp > timestamp) {
			hi = mid;
		} else {
			lo = mid;
		}
	}
	return lo;
};
