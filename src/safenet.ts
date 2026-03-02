/**
 * Safenet data source.
 */

import Sqlite3 from "better-sqlite3";
import { type Address, type Client, type ExtractAbiItem, getAbiItem } from "viem";
import { getChainId, readContract } from "viem/actions";
import { CONSENSUS_ABI, COORDINATOR_ABI, STAKING_ABI } from "./abi.js";
import { BlockTimestampCache } from "./indexing/block.js";
import { EventIndexer, type UpdateBlockRange } from "./indexing/event.js";

type SafenetChain<Events> = {
	client: Client;
	blocks: BlockTimestampCache;
	events: Events;
};

type StakingEvents = {
	stakeIncreased: EventIndexer<ExtractAbiItem<typeof STAKING_ABI, "StakeIncreased">>;
	withdrawalInitiated: EventIndexer<ExtractAbiItem<typeof STAKING_ABI, "WithdrawalInitiated">>;
	validatorUpdated: EventIndexer<ExtractAbiItem<typeof STAKING_ABI, "ValidatorUpdated">>;
};

type ConsensusEvents = {
	signShared: EventIndexer<ExtractAbiItem<typeof COORDINATOR_ABI, "SignShared">>;
	signCompleted: EventIndexer<ExtractAbiItem<typeof COORDINATOR_ABI, "SignCompleted">>;
	validatorStakerSet: EventIndexer<ExtractAbiItem<typeof CONSENSUS_ABI, "ValidatorStakerSet">>;
	transactionAttested: EventIndexer<ExtractAbiItem<typeof CONSENSUS_ABI, "TransactionAttested">>;
};

export class Safenet {
	#staking: SafenetChain<StakingEvents>;
	#consensus: SafenetChain<ConsensusEvents>;

	private constructor({
		staking,
		consensus,
	}: {
		staking: SafenetChain<StakingEvents>;
		consensus: SafenetChain<ConsensusEvents>;
	}) {
		this.#staking = staking;
		this.#consensus = consensus;
	}

	async index(range: UpdateBlockRange): Promise<void> {
		// We want to fail updating early - that is if we run into trouble with
		// a particular indexer, we want to stop the others. This prevents large
		// block ranges that take a long time to index hide early errors.
		let failedEarly = false;
		await Promise.all(
			[...Object.values(this.#staking.events), ...Object.values(this.#consensus.events)].map(
				(indexer) =>
					indexer
						.update(range, () => failedEarly)
						.catch((err) => {
							failedEarly = true;
							throw err;
						}),
			),
		);
	}

	static async create(params: {
		databaseFile: string;
		stakingClient: Client;
		stakingAddress: Address;
		stakingStartBlock?: bigint;
		consensusClient: Client;
		consensusAddress: Address;
		consensusStartBlock?: bigint;
	}): Promise<Safenet> {
		const stakingChain = await getChainId(params.stakingClient);
		const consensusChain = await getChainId(params.consensusClient);
		const coordinatorAddress = await readContract(params.consensusClient, {
			address: params.consensusAddress,
			abi: CONSENSUS_ABI,
			functionName: "COORDINATOR",
		});

		const db = new Sqlite3(params.databaseFile);
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
		return new Safenet({
			staking: {
				client: params.stakingClient,
				blocks: stakingBlocks,
				events: {
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
				},
			},
			consensus: {
				client: params.consensusClient,
				blocks: stakingBlocks,
				events: {
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
				},
			},
		});
	}
}
