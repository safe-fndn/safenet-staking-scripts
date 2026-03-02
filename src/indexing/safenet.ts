import type { Database } from "better-sqlite3";
import { type Address, type Client, type ExtractAbiItem, getAbiItem } from "viem";
import { getChainId, readContract } from "viem/actions";
import { CONSENSUS_ABI, COORDINATOR_ABI, STAKING_ABI } from "../abi.js";
import { BlockTimestampCache } from "./block.js";
import { EventIndexer, type UpdateBlockRange } from "./event.js";

export type SafenetIndexers = {
	stakingBlocks: BlockTimestampCache;
	stakeIncreased: EventIndexer<ExtractAbiItem<typeof STAKING_ABI, "StakeIncreased">>;
	withdrawalInitiated: EventIndexer<ExtractAbiItem<typeof STAKING_ABI, "WithdrawalInitiated">>;
	validatorUpdated: EventIndexer<ExtractAbiItem<typeof STAKING_ABI, "ValidatorUpdated">>;
	consensusBlocks: BlockTimestampCache;
	signShared: EventIndexer<ExtractAbiItem<typeof COORDINATOR_ABI, "SignShared">>;
	signCompleted: EventIndexer<ExtractAbiItem<typeof COORDINATOR_ABI, "SignCompleted">>;
	validatorStakerSet: EventIndexer<ExtractAbiItem<typeof CONSENSUS_ABI, "ValidatorStakerSet">>;
	transactionAttested: EventIndexer<ExtractAbiItem<typeof CONSENSUS_ABI, "TransactionAttested">>;
};

export const createSafenetIndexers = async ({
	db,
	...params
}: {
	db: Database;
	stakingClient: Client;
	stakingAddress: Address;
	stakingStartBlock?: bigint;
	consensusClient: Client;
	consensusAddress: Address;
	consensusStartBlock?: bigint;
}): Promise<SafenetIndexers> => {
	const stakingChain = await getChainId(params.stakingClient);
	const consensusChain = await getChainId(params.consensusClient);
	const coordinatorAddress = await readContract(params.consensusClient, {
		address: params.consensusAddress,
		abi: CONSENSUS_ABI,
		functionName: "COORDINATOR",
	});

	const stakingBlocks = new BlockTimestampCache({
		db,
		client: params.stakingClient,
		chainId: stakingChain,
	});
	const consensusBlocks = new BlockTimestampCache({
		db,
		client: params.consensusClient,
		chainId: consensusChain,
	});
	return {
		stakingBlocks,
		stakeIncreased: new EventIndexer({
			db,
			client: params.stakingClient,
			chainId: stakingChain,
			address: params.stakingAddress,
			event: getAbiItem({ abi: STAKING_ABI, name: "StakeIncreased" }),
			startBlock: params.stakingStartBlock,
			blocks: stakingBlocks,
		}),
		withdrawalInitiated: new EventIndexer({
			db,
			client: params.stakingClient,
			chainId: stakingChain,
			address: params.stakingAddress,
			event: getAbiItem({ abi: STAKING_ABI, name: "WithdrawalInitiated" }),
			startBlock: params.stakingStartBlock,
			blocks: stakingBlocks,
		}),
		validatorUpdated: new EventIndexer({
			db,
			client: params.stakingClient,
			chainId: stakingChain,
			address: params.stakingAddress,
			event: getAbiItem({ abi: STAKING_ABI, name: "ValidatorUpdated" }),
			startBlock: params.stakingStartBlock,
			blocks: stakingBlocks,
		}),
		consensusBlocks,
		signShared: new EventIndexer({
			db,
			client: params.consensusClient,
			chainId: consensusChain,
			address: coordinatorAddress,
			event: getAbiItem({ abi: COORDINATOR_ABI, name: "SignShared" }),
			startBlock: params.consensusStartBlock,
			blocks: consensusBlocks,
		}),
		signCompleted: new EventIndexer({
			db,
			client: params.consensusClient,
			chainId: consensusChain,
			address: coordinatorAddress,
			event: getAbiItem({ abi: COORDINATOR_ABI, name: "SignCompleted" }),
			startBlock: params.consensusStartBlock,
			blocks: consensusBlocks,
		}),
		validatorStakerSet: new EventIndexer({
			db,
			client: params.consensusClient,
			chainId: consensusChain,
			address: params.consensusAddress,
			event: getAbiItem({ abi: CONSENSUS_ABI, name: "ValidatorStakerSet" }),
			startBlock: params.consensusStartBlock,
			blocks: consensusBlocks,
		}),
		transactionAttested: new EventIndexer({
			db,
			client: params.consensusClient,
			chainId: consensusChain,
			address: params.consensusAddress,
			event: getAbiItem({ abi: CONSENSUS_ABI, name: "TransactionAttested" }),
			startBlock: params.consensusStartBlock,
			blocks: consensusBlocks,
		}),
	};
};

export const updateIndexers = async (
	indexers: Partial<SafenetIndexers>,
	range: UpdateBlockRange,
): Promise<void> => {
	// We want to fail updating early - that is if we run into trouble with a
	// particular indexer, we want to stop the others. This prevents large block
	// ranges that take a long time to index hide early errors.
	let failedEarly = false;
	await Promise.all(
		Object.values(indexers).map(async (indexer) => {
			if (indexer instanceof EventIndexer) {
				try {
					await indexer.update(range, () => failedEarly);
				} catch (err) {
					failedEarly = true;
					throw err;
				}
			}
		}),
	);
};
