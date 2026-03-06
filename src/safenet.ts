/**
 * Safenet data source.
 */

import Sqlite3 from "better-sqlite3";
import debug, { type Debugger } from "debug";
import { type Address, type Client, getAddress } from "viem";
import { getChainId, readContract } from "viem/actions";
import { CONSENSUS_ABI } from "./abi.js";
import { BlockTimestampCache } from "./indexing/block.js";
import type { EventIndexer } from "./indexing/events.js";
import { Signatures } from "./indexing/signatures.js";
import { Stake } from "./indexing/stake.js";
import { Transactions } from "./indexing/transactions.js";
import { ValidatorStakers } from "./indexing/validator-stakers.js";
import { Validators } from "./indexing/validators.js";
import { minBigInt } from "./utils/math.js";
import {
	formatRange,
	rangeContains,
	rangeDuration,
	type TimestampRange,
	type ToTimestamp,
} from "./utils/ranges.js";

export type ValidatorStats = Record<
	Address,
	{
		beneficiary: Address | null;
		stake: bigint;
	}
>;

export type Staked = {
	staker: Address;
	amounts: {
		validator: Address;
		amount: bigint;
	}[];
};

export type Participation = {
	total: number;
	validators: Record<Address, number>;
};

type StakingChain = {
	blocks: BlockTimestampCache;
	stake: Stake;
	validators: Validators;
};
type ConsensusChain = {
	blocks: BlockTimestampCache;
	stakers: ValidatorStakers;
	transactions: Transactions;
	signatures: Signatures;
};

type ValidatorRegistrations = {
	validator: Address;
	registrations: TimestampRange[];
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
	}

	async index(to: Partial<ToTimestamp> = {}): Promise<void> {
		// We want to fail updating early - that is if we run into trouble with
		// a particular indexer, we want to stop the others. This prevents large
		// block ranges that take a long time to index hide early errors.
		let failedEarly = false;
		const update = (indexer: Pick<EventIndexer, "update">, to: Partial<ToTimestamp>) =>
			indexer
				.update(to, () => failedEarly)
				.catch((err) => {
					failedEarly = true;
					throw err;
				});

		// For attestations (transaction attestations and signing ceremonies),
		// we need to add a small grace period for indexing. This is because
		// participation is computed for transactions proposed within a
		// transaction period.
		const attestTo = to;
		if (attestTo.toTimestamp !== undefined) {
			const ONE_HOUR = 60n * 60n;
			const latest = await this.#consensus.blocks.getLatest();
			attestTo.toTimestamp = minBigInt(attestTo.toTimestamp + ONE_HOUR, latest.timestamp);
		}

		await Promise.all([
			update(this.#staking.stake, to),
			update(this.#staking.validators, to),
			update(this.#consensus.stakers, to),
			update(this.#consensus.transactions, attestTo),
			update(this.#consensus.signatures, attestTo),
		]);
	}

	async #debugPeriod(period: TimestampRange): Promise<void> {
		this.#debug(`using period ${formatRange(period)}`);
		const staking = await this.#staking.blocks.blockRange(period);
		this.#debug(`staking chain block range ${formatRange(staking)}`);
		const consensus = await this.#consensus.blocks.blockRange(period);
		this.#debug(`consensus chain block range ${formatRange(consensus)}`);
	}

	async #validatorRegistrations(period: TimestampRange): Promise<ValidatorRegistrations[]> {
		await this.index(period);
		const set = await this.#staking.validators.validatorSet(period);
		return Object.entries(set).map(([key, registrations]) => ({
			validator: getAddress(key),
			registrations,
		}));
	}

	async #validatorSelfStake(
		period: TimestampRange,
		{ validator, registrations }: ValidatorRegistrations,
	): Promise<{ beneficiary: Address | null; stake: bigint }> {
		const result = {
			beneficiary: null as Address | null,
			stake: 0n,
		};

		// Note that validator registrations can have holes in them, which
		// matters when computing weighted time averages. In particular, we only
		// want to count stake that was there _while_ the validator was
		// registered. Go over all registration slices for the validator over
		// the total period, for each slice get the registered stakers (which
		// may itself change over that period) and compute the average stake
		// over those sub-ranges.

		for (const registration of registrations) {
			const stakers = await this.#consensus.stakers.validatorStakers({
				validator,
				...registration,
			});
			for (const { staker, ...slice } of stakers) {
				// Note that the staker that receives the commissions is defined
				// to be the **last** staker set by the validator. Keep track of
				// the last seen staker as we go over the time slices.
				result.beneficiary = staker;
				result.stake += await this.#staking.stake.timeWeightedStake({
					staker,
					validator,
					...slice,
				});
			}
		}

		result.stake /= rangeDuration(period);
		return result;
	}

	/**
	 * Compute stats about all active validators within a period.
	 *
	 * The stats include the average stake for the validator as well as their
	 * participation rate. Along with the average stake, the beneficiary for
	 * the commissions (defined to be the last set validator staker) is also
	 * returned.
	 */
	async validatorStats(period: TimestampRange): Promise<ValidatorStats> {
		await this.#debugPeriod(period);

		const stats = {} as ValidatorStats;
		const validators = await this.#validatorRegistrations(period);
		for (const { validator, registrations } of validators) {
			const { beneficiary, stake } = await this.#validatorSelfStake(period, {
				validator,
				registrations,
			});
			stats[validator] = {
				beneficiary,
				stake,
			};
		}

		return stats;
	}

	/**
	 * Compute the average staked amounts per staker/validator pair over a
	 * period.
	 *
	 * The staked amounts are provided as a streaming interface to avoid loading
	 * staking data for all stakers into memory at once.
	 */
	async *staked(period: TimestampRange): AsyncGenerator<Staked> {
		await this.#debugPeriod(period);

		// We need to, even for computed average stake amounts, get the set of
		// validators and their registration periods, because we only want any
		// particular stake to count to the weighted average during a
		// registration period.
		const validators = await this.#validatorRegistrations(period);

		for await (const staker of this.#staking.stake.stakers(period)) {
			const amounts = [] as Staked["amounts"];
			for (const { validator, registrations } of validators) {
				let amount = 0n;
				for (const registration of registrations) {
					amount += await this.#staking.stake.timeWeightedStake({
						staker,
						validator,
						...registration,
					});
				}
				if (amount > 0n) {
					amount /= rangeDuration(period);
					amounts.push({ validator, amount });
				}
			}
			yield {
				staker,
				amounts,
			};
		}
	}

	async participation(
		period: TimestampRange,
		options: { approximate?: boolean } = {},
	): Promise<Participation> {
		await this.#debugPeriod(period);

		// Get the validator registration periods, to make sure to only count
		// participation when a validator is registered.
		const registrations = Object.fromEntries(
			(await this.#validatorRegistrations(period)).map(({ validator, registrations }) => [
				validator,
				registrations,
			]),
		);

		if (options.approximate === true) {
			const { total, participants } =
				await this.#consensus.signatures.approximateParticipation(period);
			const validators = Object.fromEntries(
				Object.keys(registrations).map((validator) => [
					validator as Address,
					participants[validator as Address] ?? 0,
				]),
			);
			return { total, validators };
		} else {
			const participation = {
				total: 0,
				validators: Object.fromEntries(
					Object.keys(registrations).map((validator) => [validator as Address, 0]),
				),
			};
			for await (const { timestamp, ...packet } of this.#consensus.transactions.packets(period)) {
				participation.total++;
				for (const participant of this.#consensus.signatures.participants(packet)) {
					if (registrations[participant]?.some((period) => rangeContains(period, timestamp))) {
						participation.validators[participant] = participation.validators[participant] + 1;
					}
				}
			}
			return participation;
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
		const consensusConfig = {
			db,
			blocks: consensusBlocks,
			client: params.consensusClient,
			blockPageSize: params.blockPageSize,
			chainId: consensusChain,
			address: params.consensusAddress,
			startBlock: params.consensusStartBlock,
		};
		const coordinatorConfig = {
			...consensusConfig,
			address: coordinatorAddress,
		};
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
				stakers: new ValidatorStakers(consensusConfig),
				transactions: new Transactions(consensusConfig),
				signatures: new Signatures(coordinatorConfig),
			},
		});
	}
}
