/**
 * The export pipeline: builds a distribution package on top of the ENS-pinned rewards DB.
 *
 * A distribution is a function of the pinned rewards DB, the chain history up to the period's
 * settlement and the inputs versioned with the code. This module currently covers its inputs:
 * the governance configuration and the previous rewards DB, read at one block, the two-week period
 * that follows the previous rewards DB, and the reward amounts for that period.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import debug from "debug";
import { type Address, type Client, getAddress } from "viem";
import { getBlockNumber, getChainId } from "viem/actions";
import { MerkleDb, nextRewardsStart } from "../merkledb/index.js";
import { rewardsPeriod, sentinelRewardsAmount, totalRewardsAmount } from "../utils/args.js";
import { backoff } from "../utils/backoff.js";
import type { GitHubRepository } from "../utils/gh.js";
import type { TimestampRange } from "../utils/ranges.js";
import { governanceConfiguration } from "./governance.js";
import { copyRewardsDb } from "./package.js";
import { type CarSource, type RewardsDb, resolvePreviousRewardsDb } from "./previous.js";
import { GOVERNANCE_CHAIN_ID, type GovernanceConfiguration } from "./transactions.js";

/**
 * The configuration an export reads the chains with. It is a superset of the `Safenet.create`
 * parameters, so the parsed command arguments can be passed as is.
 */
export type ExportConfiguration = CarSource & {
	/** Ethereum mainnet: staking, the governance contracts, ENS and the drop. */
	stakingClient: Client;
	stakingAddress: Address;
	stakingStartBlock?: bigint;
	delegateRegistryAddress: Address;
	sanctionsListAddress: Address;
	sanctionsAddressRepo?: GitHubRepository;
	/** Gnosis Chain: consensus and the sentinel oracle. */
	consensusClient: Client;
	consensusAddress: Address;
	sentinelOracleAddress: Address;
	cumulativeMerkleDropAddress: Address;
	realityModuleAddress: Address;
	rewardsEnsName: string;
};

/**
 * What a distribution builds on, all read at one block of the staking chain.
 */
export type ExportInputs = {
	stakingChainId: number;
	/** The staking chain block the governance configuration and the previous rewards DB are read at. */
	blockNumber: bigint;
	governance: GovernanceConfiguration;
	/** The previous rewards DB the distribution builds on. */
	previous: Pick<RewardsDb, "cid" | "merkleRoot" | "rewardsUntil">;
	/** The two weeks that follow the previous rewards DB, which the distribution pays for. */
	period: TimestampRange;
	/** The Aegis validator budget for the period, measured against the previous rewards DB. */
	totalRewards: bigint;
	/** The per-sentinel grant, prorated over the period. */
	sentinelRewards: bigint;
};

const log = debug("safenet:export");

/**
 * Reads the inputs of a distribution and copies the previous rewards DB into `dir`, which must be
 * empty or missing, for the distribution to build on.
 *
 * The governance configuration and both references to the previous rewards DB, the ENS
 * `contenthash` and the drop's Merkle root, are read at the same block, so they describe one
 * onchain state. The previous rewards DB is unpacked into a temporary directory that is always
 * removed.
 *
 * The period is never chosen by the caller: it is the two weeks starting where the previous
 * rewards DB ends (`nextRewardsStart`, so the first Aegis period follows the end of Beta). It may
 * not have ended or settled yet, which the period's rewards queries then refuse.
 *
 * The amounts are never overridden: the validator budget is the Aegis default measured against
 * the previous rewards DB, and the sentinel grant is prorated over the period, so that every
 * export can be verified.
 */
export const exportInputs = async (
	config: Pick<
		ExportConfiguration,
		| "stakingClient"
		| "cumulativeMerkleDropAddress"
		| "realityModuleAddress"
		| "rewardsEnsName"
		| keyof CarSource
	>,
	dir: string,
): Promise<ExportInputs> => {
	const withBackoff = backoff({ debug: log });
	const client = config.stakingClient;
	const stakingChainId = await withBackoff(() => getChainId(client));
	if (stakingChainId !== GOVERNANCE_CHAIN_ID) {
		throw new Error(`staking chain ${stakingChainId} is not the governance chain`);
	}

	// The governance configuration and both references to the previous rewards DB are read at
	// the same block, so they describe one onchain state.
	const blockNumber = await withBackoff(() => getBlockNumber(client, { cacheTime: 0 }));
	const ensName = config.rewardsEnsName;
	const governance = await governanceConfiguration(
		client,
		{ module: config.realityModuleAddress, ensName, blockNumber },
		{ withBackoff },
	);
	const cumulativeMerkleDrop = getAddress(config.cumulativeMerkleDropAddress);

	const temporary = await mkdtemp(join(tmpdir(), "safenet-export-"));
	try {
		const previous = await resolvePreviousRewardsDb(
			client,
			{ ensName, cumulativeMerkleDrop, blockNumber },
			config,
			join(temporary, "previous"),
			{ withBackoff },
		);
		if (previous.ensResolver !== governance.ensResolver) {
			throw new Error(`ENS resolver ${previous.ensResolver} != ${governance.ensResolver}`);
		}
		await copyRewardsDb(previous.dir, dir);

		const period = rewardsPeriod({ rewardPeriodStart: nextRewardsStart(previous.rewardsUntil) });
		const args = { rewardPeriodStart: period.fromTimestamp, rewardPeriodEnd: period.toTimestamp };
		const totalRewards = await totalRewardsAmount(args, new MerkleDb({ root: dir }));
		const sentinelRewards = sentinelRewardsAmount(args);

		const { cid, merkleRoot, rewardsUntil } = previous;
		log(
			`building [${period.fromTimestamp}, ${period.toTimestamp}] on ${cid} at block ${blockNumber}`,
		);
		return {
			stakingChainId,
			blockNumber,
			governance,
			previous: { cid, merkleRoot, rewardsUntil },
			period,
			totalRewards,
			sentinelRewards,
		};
	} finally {
		await rm(temporary, { force: true, recursive: true });
	}
};
