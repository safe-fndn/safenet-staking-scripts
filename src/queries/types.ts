export type Blocks = {
	getTimestamp(params: { blockNumber: bigint }): Promise<bigint | null>;
}

export type EventTable = {
	readonly table: string
};
