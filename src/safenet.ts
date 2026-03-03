/**
 * Safenet data source.
 */

import Sqlite3, { type Database } from "better-sqlite3";
import { type Address, type Client, type ExtractAbiItem, getAbiItem } from "viem";
import { getChainId, readContract } from "viem/actions";
import { CONSENSUS_ABI, COORDINATOR_ABI, STAKING_ABI } from "./abi.js";
import { BlockTimestampCache, type TimestampRange } from "./indexing/block.js";
import { EventIndexer, type UpdateBlockRange } from "./indexing/event.js";
import { type ValidatorSetQuery, validatorSet } from "./queries/validator-set.js";

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

export type RewardsPeriod = TimestampRange & {
	blockPageSize: bigint;
};

export class Safenet {
	#staking: SafenetChain<StakingEvents>;
	#consensus: SafenetChain<ConsensusEvents>;
	#validatorSet: ValidatorSetQuery;

	private constructor({
		db,
		staking,
		consensus,
	}: {
		db: Database;
		staking: SafenetChain<StakingEvents>;
		consensus: SafenetChain<ConsensusEvents>;
	}) {
		this.#staking = staking;
		this.#consensus = consensus;

		this.#validatorSet = validatorSet({
			db,
			validatorUpdated: staking.events.validatorUpdated,
		});
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

	async validatorStats(period: RewardsPeriod): Promise<void> {
		const range = await this.#staking.blocks.searchBlockRange(period);
		if (range === null) {
			throw new Error("invalid payout period range");
		}

		await this.index({ ...period, ...range });
		const set = await this.#validatorSet({ staking: range });
		console.log(set);
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
			db,
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
