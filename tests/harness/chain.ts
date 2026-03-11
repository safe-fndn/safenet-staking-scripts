import { type Address, encodePacked, type Hex, keccak256, type RpcLog, toHex } from "viem";

export type LogSpec = {
	address: Address;
	topics: Hex[];
	data: Hex;
};

export type BlockSpec = {
	logs?: LogSpec[];
};

export type ChainSpec = {
	chainId: number;
	blockTime: bigint;
	slots: (BlockSpec | null)[];
};

type Block = {
	number: bigint;
	timestamp: bigint;
	logs: RpcLog[];
};

const makeRpcLog = (
	blockNumber: bigint,
	logIndex: bigint,
	{ address, topics, data }: LogSpec,
): RpcLog => ({
	address,
	// Weird TypeScript limitation: we get an error that `Hex[]` is not
	// assignable to `[Hex, ...Hex[]] | []`, but there are no values of the
	// former type that do not fit into the latter.
	topics: topics as RpcLog["topics"],
	data,
	blockNumber: toHex(blockNumber),
	blockHash: keccak256(toHex(blockNumber)),
	transactionHash: keccak256(encodePacked(["uint64", "uint64"], [blockNumber, logIndex])),
	transactionIndex: toHex(logIndex),
	logIndex: toHex(logIndex),
	removed: false,
});

const appendBlock = (
	blocks: [bigint, Block][],
	number: bigint,
	timestamp: bigint,
	spec: BlockSpec,
): [bigint, Block][] => {
	const logs = spec.logs?.map((log, i) => makeRpcLog(number, BigInt(i), log)) ?? [];
	blocks.push([number, { number, timestamp, logs }]);
	return blocks;
};

export class MockChain {
	#chainId: number;
	#blocks: Map<bigint, Block>;

	constructor({ chainId, blockTime, slots }: ChainSpec) {
		this.#chainId = chainId;
		this.#blocks = new Map(
			slots.reduce(
				({ number, timestamp, blocks }, slot) =>
					slot === null
						? {
								number,
								timestamp: timestamp + blockTime,
								blocks,
							}
						: {
								number: number + 1n,
								timestamp: timestamp + blockTime,
								blocks: appendBlock(blocks, number, timestamp, slot),
							},
				{
					number: 1n,
					timestamp: 0n,
					blocks: [] as [bigint, Block][],
				},
			)?.blocks,
		);
	}

	chainId(): number {
		return this.#chainId;
	}

	blockNumbers(): Iterator<bigint> {
		return this.#blocks.keys();
	}
}
