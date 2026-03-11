import {
	type Address,
	type Client,
	createClient,
	custom,
	encodeAbiParameters,
	encodeFunctionData,
	encodePacked,
	getAddress,
	type Hex,
	isHex,
	keccak256,
	parseAbiParameters,
	type RpcBlock,
	type RpcLog,
	toHex,
	zeroAddress,
	zeroHash,
} from "viem";
import { z } from "zod";
import { CONSENSUS_ABI } from "../../src/abi.js";
import { namedAddress } from "./utils.js";

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

export type LogFilter = {
	address: Address;
	topics: (Hex | Hex[] | null)[];
	fromBlock: bigint;
	toBlock: bigint;
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
	blockHash: keccak256(toHex(blockNumber, { size: 8 })),
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

const logMatches = (
	log: RpcLog,
	{ address, topics }: Pick<LogFilter, "address" | "topics">,
): boolean => {
	if (log.address !== address) {
		return false;
	}
	for (let i = 0; i < topics.length; i++) {
		const t = topics[i];
		if (t === null) {
			continue;
		}
		const l = log.topics.at(i);
		if (l === undefined || ![t].flat().includes(l)) {
			return false;
		}
	}
	return true;
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

	blockNumber(): bigint {
		return [...this.#blocks.keys()].reduce((max, n) => (n > max ? n : max), 0n);
	}

	getBlock(n: bigint): RpcBlock | null {
		const block = this.#blocks.get(n);
		return block !== undefined
			? {
					number: toHex(block.number),
					timestamp: toHex(block.timestamp),
					hash: keccak256(toHex(block.number, { size: 8 })),
					parentHash: keccak256(toHex(block.number - 1n, { size: 8 })),
					// stubbed fields
					baseFeePerGas: null,
					blobGasUsed: "0x0",
					difficulty: "0x0",
					excessBlobGas: "0x0",
					extraData: "0x",
					gasLimit: "0x0",
					gasUsed: "0x0",
					logsBloom: null,
					miner: zeroAddress,
					mixHash: zeroHash,
					nonce: null,
					receiptsRoot: zeroHash,
					sealFields: [],
					sha3Uncles: zeroHash,
					size: "0x0",
					stateRoot: zeroHash,
					totalDifficulty: null,
					transactions: [],
					transactionsRoot: zeroHash,
					uncles: [],
				}
			: null;
	}

	getLogs({ address, topics, fromBlock, toBlock }: LogFilter): RpcLog[] {
		const result = [] as RpcLog[];
		for (let n = fromBlock; n <= toBlock; n++) {
			const logs = this.#blocks.get(n)?.logs ?? [];
			for (const log of logs) {
				if (logMatches(log, { address, topics })) {
					result.push({
						...log,
						topics: [...log.topics],
					});
				}
			}
		}
		return result;
	}
}

export function createMockClient(chain: MockChain): Client {
	const zAddress = z.string().transform((s) => getAddress(s));
	const zHex = z
		.string()
		.refine((s) => isHex(s))
		.transform((s) => s as Hex);
	return createClient({
		transport: custom({
			async request({ method, params }) {
				switch (method) {
					case "eth_chainId":
						return toHex(chain.chainId());

					case "eth_blockNumber":
						return toHex(chain.blockNumber());

					case "eth_getBlockByNumber": {
						const [blockTag] = z
							.tuple([z.union([z.literal("latest"), z.coerce.bigint()]), z.boolean()])
							.parse(params);
						const n = blockTag === "latest" ? chain.blockNumber() : BigInt(blockTag);
						return chain.getBlock(n);
					}

					case "eth_getLogs": {
						const [filter] = z
							.tuple([
								z.object({
									address: zAddress,
									topics: zHex.array(),
									fromBlock: z.coerce.bigint(),
									toBlock: z.coerce.bigint(),
								}),
							])
							.parse(params);
						return chain.getLogs(filter);
					}

					case "eth_call":
						z.tuple([
							z.object({
								to: namedAddress("Consensus"),
								data: encodeFunctionData({
									abi: CONSENSUS_ABI,
									functionName: "COORDINATOR",
								}),
							}),
							z.literal("latest"),
						]).parse(params);
						return encodeAbiParameters(parseAbiParameters("address"), [
							namedAddress("FROSTCoordinator"),
						]);

					default:
						throw new Error(`MockChain: unsupported JSON-RPC method "${method}"`);
				}
			},
		}),
	});
}
