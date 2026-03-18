/**
 * Safenet data source.
 */

import Sqlite3 from "better-sqlite3";
import debug, { type Debugger } from "debug";
import { type Address, type Client, getAddress, parseUnits, zeroAddress } from "viem";
import { getChainId, readContract } from "viem/actions";
import { CONSENSUS_ABI } from "./abi.js";
import { BlockTimestampCache } from "./indexing/block.js";
import type { EventIndexer } from "./indexing/events.js";
import { Signatures } from "./indexing/signatures.js";
import { Stake } from "./indexing/stake.js";
import { Transactions } from "./indexing/transactions.js";
import { ValidatorStakers } from "./indexing/validator-stakers.js";
import { Validators } from "./indexing/validators.js";
import { formatRange } from "./utils/format.js";
import { minBigInt, sqrtBigInt } from "./utils/math.js";
import {
	rangeContains,
	rangeDuration,
	type TimestampRange,
	type ToTimestamp,
} from "./utils/ranges.js";

export type ValidatorStats = Record<
	Address,
	{
		beneficiary: Address;
		stake: {
			self: {
				amount: bigint;
				stakers: Record<Address, bigint>;
			};
			total: bigint;
		};
	}
>;

export type Staked = {
	staker: Address;
	amounts: {
		validator: Address;
		amount: bigint;
	}[];
};

export type ParticipationOptions = {
	approximate?: boolean;
};

export type Participation = {
	total: number;
	validators: Record<Address, number>;
};

export type Rewards = {
	payouts: Record<Address, bigint>;
	unpaid: bigint;
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

type ValidatorSelfStake = {
	beneficiary: Address;
	amount: bigint;
	stakers: Record<Address, bigint>;
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
		const attestTo = { ...to };
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
	): Promise<ValidatorSelfStake> {
		const result = {
			beneficiary: zeroAddress,
			amount: 0n,
			stakers: {},
		} as ValidatorSelfStake;

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
				const stake = await this.#staking.stake.timeWeightedStake({
					staker,
					validator,
					...slice,
				});

				// Note that the staker that receives the commissions is defined
				// to be the **last** staker set by the validator. Keep track of
				// the last seen staker as we go over the time slices.
				result.beneficiary = staker;
				result.amount += stake;
				result.stakers[staker] = (result.stakers[staker] ?? 0n) + stake;
			}
		}

		const duration = rangeDuration(period);
		result.amount /= duration;
		for (const staker of addresses(result.stakers)) {
			result.stakers[staker] /= duration;
		}

		return result;
	}

	async #validatorTotalStake(
		period: TimestampRange,
		{ validator, registrations }: ValidatorRegistrations,
	): Promise<bigint> {
		let total = 0n;
		for (const registration of registrations) {
			for await (const staker of this.#staking.stake.stakers(registration)) {
				total += await this.#staking.stake.timeWeightedStake({
					staker,
					validator,
					...registration,
				});
			}
		}
		return total / rangeDuration(period);
	}

	async #validatorStats(
		period: TimestampRange,
		validators: ValidatorRegistrations[],
	): Promise<ValidatorStats> {
		const stats = {} as ValidatorStats;
		for (const { validator, registrations } of validators) {
			const { beneficiary, ...self } = await this.#validatorSelfStake(period, {
				validator,
				registrations,
			});
			const total = await this.#validatorTotalStake(period, { validator, registrations });
			stats[validator] = {
				beneficiary,
				stake: { self, total },
			};
		}
		return stats;
	}

	async *#staked(
		period: TimestampRange,
		validators: ValidatorRegistrations[],
	): AsyncGenerator<Staked> {
		for await (const staker of this.#staking.stake.stakers(period)) {
			const amounts = [] as Staked["amounts"];

			// We need to, even for computed average stake amounts, compute them
			// over the validator's registration periods, because we only want
			// any particular stake to count to the weighted average during a
			// registration period.
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

	async #participation(
		period: TimestampRange,
		validators: ValidatorRegistrations[],
		options: ParticipationOptions,
	): Promise<Participation> {
		const registrations = Object.fromEntries(
			validators.map(({ validator, registrations }) => [validator, registrations]),
		);

		if (options.approximate === true) {
			const { total, participants } =
				await this.#consensus.signatures.approximateParticipation(period);
			const validators = Object.fromEntries(
				[...addresses(registrations)].map((validator) => [validator, participants[validator] ?? 0]),
			);
			return { total, validators };
		} else {
			const participation = {
				total: 0,
				validators: Object.fromEntries(
					[...addresses(registrations)].map((validator) => [validator, 0]),
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
		const validators = await this.#validatorRegistrations(period);
		return await this.#validatorStats(period, validators);
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
		const validators = await this.#validatorRegistrations(period);
		for await (const stake of this.#staked(period, validators)) {
			yield stake;
		}
	}

	async participation(
		period: TimestampRange,
		options: ParticipationOptions = {},
	): Promise<Participation> {
		await this.#debugPeriod(period);
		const validators = await this.#validatorRegistrations(period);
		return await this.#participation(period, validators, options);
	}

	/**
	 * Compute rewards for all validators and delegators within a period.
	 *
	 * Rewards are distributed proportionally to each validator's participation-
	 * weighted stake. Validators below the 75% participation threshold or the
	 * 3.5M SAFE minimum self-stake forfeit their self-stake earnings. Individual
	 * payouts below 1 SAFE are carried forward as unpaid.
	 *
	 * Based on the rewards calculation specification from:
	 * <https://docs.safefoundation.org/safenet/staking/rewards>
	 */
	async rewards(
		period: TimestampRange,
		totalRewards: bigint,
		options: ParticipationOptions = {},
	): Promise<Rewards> {
		await this.#debugPeriod(period);
		const validators = await this.#validatorRegistrations(period);

		if (validators.length === 0) {
			// If there are no validators, there are no rewards. We exit early
			// here to prevent some "divide by zero" errors that would happen
			// if we tried to compute rewards with an empty validator set.
			return { payouts: {}, unpaid: totalRewards };
		}

		const [stats, participation] = await Promise.all([
			this.#validatorStats(period, validators),
			this.#participation(period, validators, options),
		]);

		// Compute the linear reward threshold `T` for each valiator and the
		// stake weighting for each validator. Weights are scaled by 1e18 in
		// order to keep 18 decimal places of precision.
		const totalNetworkStake = Object.values(stats)
			.map((v) => v.stake.total)
			.reduce((acc, v) => acc + v, 0n);
		const threshold = totalNetworkStake / BigInt(validators.length);
		const weights = {} as Record<Address, bigint>;
		for (const { validator } of validators) {
			// First, check if the validator's participation rate is high enough
			// to be considered for rewards.
			const participationRate = participation.validators[validator] / participation.total;
			if (participationRate < 0.75) {
				weights[validator] = 0n;
				continue;
			}

			const stakeWeight =
				stats[validator].stake.total <= threshold
					? stats[validator].stake.total
					: sqrtBigInt(threshold * stats[validator].stake.total);
			const effectiveWeight =
				(stakeWeight * BigInt(participation.validators[validator]) * BigInt(1e18)) /
				BigInt(participation.total);
			weights[validator] = effectiveWeight;
		}

		const totalWeight = Object.values(weights).reduce((acc, w) => acc + w, 0n);
		if (totalWeight === 0n) {
			// There are no rewards to distribute.
			return { payouts: {}, unpaid: totalRewards };
		}

		const validatorRewards = Object.fromEntries(
			validators.map(({ validator }) => [
				validator,
				(totalRewards * weights[validator]) / totalWeight,
			]),
		);

		// We need to differentiate between validator stakers and delegate
		// stakers for the payouts, so create a registry of all validator
		// stakers and the average stake amounts. We use this to compute the
		// delegated stake amount for each staker.
		const validatorStakers = {} as Record<Address, Record<Address, bigint | undefined>>;
		for (const [validator, { stake }] of addressEntries(stats)) {
			validatorStakers[validator] = validatorStakers[validator] || {};
			for (const [staker, amount] of addressEntries(stake.self.stakers)) {
				validatorStakers[validator][staker] = (validatorStakers[validator][staker] ?? 0n) + amount;
			}
		}

		const payouts = {} as Record<Address, bigint>;
		const addPayout = (payee: Address, amount: bigint): void => {
			payouts[payee] = (payouts[payee] ?? 0n) + amount;
		};

		// Compute the self-stake rewards for each validator.
		for (const { validator } of validators) {
			const validatorStat = stats[validator];

			// Skip validators with no stake - they don't get self-rewards.
			if (validatorStat.stake.total === 0n) {
				continue;
			}

			const selfReward =
				(validatorRewards[validator] * validatorStat.stake.self.amount) / validatorStat.stake.total;
			addPayout(validatorStat.beneficiary, selfReward);
		}

		// Compute the payout amounts to each delegated staker.
		const MIN_SELF_STAKE = parseUnits("3500000.0", 18);
		const COMMISSION_BPS = 500n;
		for await (const { staker, amounts } of this.#staked(period, validators)) {
			for (const { validator, amount } of amounts) {
				const validatorStat = stats[validator];
				const delegateAmount = amount - (validatorStakers[validator][staker] ?? 0n);
				const delegateReward =
					(validatorRewards[validator] * delegateAmount) / validatorStat.stake.total;
				const commission =
					validatorStat.stake.self.amount >= MIN_SELF_STAKE
						? (delegateReward * COMMISSION_BPS) / 10000n
						: 0n;
				addPayout(staker, delegateReward - commission);
				addPayout(validatorStat.beneficiary, commission);
			}
		}

		// Remove any payments that are below the minimum payout threshold.
		const MIN_PAYOUT = parseUnits("1.0", 18);
		for (const [payee, amount] of addressEntries(payouts)) {
			if (amount < MIN_PAYOUT) {
				delete payouts[payee];
			}
		}

		// Compute the total unpaid amount.
		let unpaid = totalRewards;
		for (const [, amount] of addressEntries(payouts)) {
			unpaid -= amount;
		}

		return { payouts, unpaid };
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
			functionName: "getCoordinator",
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

function* addresses<V>(record: Record<Address, V>): Generator<Address> {
	for (const key in record) {
		yield getAddress(key);
	}
}

function* addressEntries<V>(record: Record<Address, V>): Generator<[Address, V]> {
	for (const key in record) {
		const address = getAddress(key);
		yield [address, record[address]];
	}
}
