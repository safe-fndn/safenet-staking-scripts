import type { BlockRange, BlockTimestampCache } from "../indexing/block.js";
import type { EventIndexer } from "../indexing/event.js";

export type Blocks = Pick<BlockTimestampCache, "getTimestamp">;

export type Event = Pick<EventIndexer, "table">;

export type { BlockRange } from "../indexing/block.js";
export type QueryRange = {
	staking: BlockRange;
	consensus: BlockRange;
};

export type Query<Args, Result> = (args: Args) => Promise<Result>;
