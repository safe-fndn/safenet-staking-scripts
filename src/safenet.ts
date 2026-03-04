/**
 * Safenet data source.
 */

import Sqlite3 from "better-sqlite3";
import debug, { type Debugger } from "debug";
import type { Address, Client } from "viem";
import { getChainId, readContract } from "viem/actions";
import { CONSENSUS_ABI } from "./abi.js";
import { BlockTimestampCache } from "./indexing/block.js";
import { Stake, type Staked } from "./indexing/stake.js";
import { Validators } from "./indexing/validators.js";
import type { TimestampRange, ToTimestamp } from "./utils/ranges.js";

type StakingChain = {
	blocks: BlockTimestampCache;
	stake: Stake;
	validators: Validators;
};
type ConsensusChain = {
	blocks: BlockTimestampCache;
};

export class Safenet {
	#debug: Debugger;
	#staking: StakingChain;
	#consensus: ConsensusChain;

	private constructor({
		staking,
		consensus,
	}: {
		staking: StakingChain;
		consensus: ConsensusChain;
	}) {
		this.#debug = debug("safenet");
		this.#staking = staking;
		this.#consensus = consensus;

		this.#debug(`${this.#consensus}`);
	}

	async index(to: Partial<ToTimestamp> = {}): Promise<void> {
		// We want to fail updating early - that is if we run into trouble with
		// a particular indexer, we want to stop the others. This prevents large
		// block ranges that take a long time to index hide early errors.
		let failedEarly = false;
		await Promise.all(
			[this.#staking.stake, this.#staking.validators].map((indexer) =>
				indexer
					.update(to, () => failedEarly)
					.catch((err) => {
						failedEarly = true;
						throw err;
					}),
			),
		);
	}

	async validatorStats(period: TimestampRange) {
		await this.index(period);
		const set = await this.#staking.validators.validatorSet(period);
		console.log(set);
	}

	async *staked(period: TimestampRange): AsyncGenerator<Staked> {
		await this.index(period);
		const staked = this.#staking.stake.staked(period);
		for await (const item of staked) {
			yield item;
		}
	}

	static async create(params: {
		databaseFile: string;
		blockPageSize: bigint;
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
		console.log(coordinatorAddress);

		const db = new Sqlite3(params.databaseFile);
		const stakingBlocks = new BlockTimestampCache({
			db,
			client: params.stakingClient,
			chainId: stakingChain,
		});
		const stakingConfig = {
			db,
			blocks: stakingBlocks,
			client: params.stakingClient,
			blockPageSize: params.blockPageSize,
			chainId: stakingChain,
			address: params.stakingAddress,
			startBlock: params.stakingStartBlock,
		};
		const consensusBlocks = new BlockTimestampCache({
			db,
			client: params.consensusClient,
			chainId: consensusChain,
		});
		return new Safenet({
			staking: {
				blocks: stakingBlocks,
				stake: new Stake({
					...stakingConfig,
				}),
				validators: new Validators(stakingConfig),
			},
			consensus: {
				blocks: consensusBlocks,
			},
		});
	}
}
