/**
 * The export pipeline: builds a distribution package on top of the ENS-pinned rewards DB.
 *
 * A distribution is a function of the pinned rewards DB, the chain history up to the period's
 * settlement and the inputs versioned with the code. This module currently covers its inputs:
 * the governance configuration and the previous rewards DB, read at one block, and the effective
 * reward amounts for the period.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import debug from "debug";
import { type Address, type Client, getAddress } from "viem";
import { getBlockNumber, getChainId } from "viem/actions";
import { MerkleDb, nextRewardsStart } from "../merkledb/index.js";
import { sentinelRewardsAmount, totalRewardsAmount } from "../utils/args.js";
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
 * The period of a distribution, and its reward amounts if they are overridden.
 */
export type ExportPeriod = {
	period: TimestampRange;
	/** Overrides the Aegis validator budget for the period. */
	totalRewards?: bigint;
	/** Overrides the prorated per-sentinel grant for the period. */
	sentinelRewards?: bigint;
};

/**
 * What a distribution builds on, all read at one block of the staking chain.
 */
export type ExportInputs = {
	stakingChainId: number;
	/** The staking chain block the governance configuration and the previous rewards DB are read at. */
	blockNumber: bigint;
	governance: GovernanceConfiguration;
	/** The previous rewards DB, in the shape of the manifest's `previous` block. */
	previous: Pick<RewardsDb, "cid" | "merkleRoot" | "rewardsUntil">;
	/** The effective validator budget for the period. */
	totalRewards: bigint;
	/** The effective per-sentinel grant for the period. */
	sentinelRewards: bigint;
};

const log = debug("safenet:export");

/**
 * Reads the inputs of a distribution and copies the previous rewards DB into `dir`, which must be
 * empty or missing, for the distribution to build on.
 *
 * The governance configuration and both references to the previous rewards DB, the ENS
 * `contenthash` and the drop's Merkle root, are read at the same block, so they describe one
 * onchain state. The period must start where the previous rewards DB ends. The previous rewards
 * DB is unpacked into a temporary directory that is always removed.
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
	{ period, ...overrides }: ExportPeriod,
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
		const expectedStart = nextRewardsStart(previous.rewardsUntil);
		if (period.fromTimestamp !== expectedStart || period.toTimestamp <= expectedStart) {
			throw new Error(
				`period [${period.fromTimestamp}, ${period.toTimestamp}] does not follow rewards DB ` +
					`${previous.cid}, which ends at ${previous.rewardsUntil}`,
			);
		}
		await copyRewardsDb(previous.dir, dir);

		const args = {
			rewardPeriodStart: period.fromTimestamp,
			rewardPeriodEnd: period.toTimestamp,
			...overrides,
		};
		const totalRewards = await totalRewardsAmount(args, new MerkleDb({ root: dir }));
		const sentinelRewards = sentinelRewardsAmount(args);

		const { cid, merkleRoot, rewardsUntil } = previous;
		log(`building on ${cid} at block ${blockNumber}`);
		return {
			stakingChainId,
			blockNumber,
			governance,
			previous: { cid, merkleRoot, rewardsUntil },
			totalRewards,
			sentinelRewards,
		};
	} finally {
		await rm(temporary, { force: true, recursive: true });
	}
};
