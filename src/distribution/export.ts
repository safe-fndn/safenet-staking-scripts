/**
 * The export pipeline: builds a distribution package on top of the ENS-pinned rewards DB.
 *
 * A distribution is a function of the pinned rewards DB, the chain history up to the period's
 * settlement and the inputs versioned with the code. This wires the pieces together:
 *
 * 1. reads the governance configuration and resolves the previous rewards DB at one block;
 * 2. computes the period's validator and sentinel rewards and pins its sanctions;
 * 3. distributes them on top of a copy of the previous rewards DB, with the KYC file;
 * 4. writes the manifest and allocations next to it and packs the package;
 * 5. builds the proposal and its action bundles.
 *
 * Everything is returned in memory; writing release assets is up to the caller.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import debug from "debug";
import type { CID } from "multiformats/cid";
import { type Address, type Client, getAddress } from "viem";
import { getBlockNumber, getChainId } from "viem/actions";
import { DEFAULT_SANCTIONS_ADDRESS_REPO } from "../data/sanctions.js";
import { MerkleDb, nextRewardsStart } from "../merkledb/index.js";
import { distributionPayouts, mergeRewardPayouts, type Safenet } from "../safenet.js";
import { sentinelRewardsAmount, totalRewardsAmount } from "../utils/args.js";
import { backoff } from "../utils/backoff.js";
import { blockAtTimestamp } from "../utils/blocks.js";
import type { GitHubRepository } from "../utils/gh.js";
import type { TimestampRange } from "../utils/ranges.js";
import { type ActionBundles, actionBundles } from "./actions.js";
import { type Allocation, buildAllocations } from "./allocations.js";
import type { Generator } from "./generator.js";
import { governanceConfiguration } from "./governance.js";
import { IPFS_PARAMETERS, packDirectory } from "./ipfs.js";
import { kyc as committedKyc } from "./kyc.js";
import type { Manifest } from "./manifest.js";
import { copyRewardsDb, writePackageFiles } from "./package.js";
import { type CarSource, type RewardsDb, resolvePreviousRewardsDb } from "./previous.js";
import {
	GOVERNANCE_CHAIN_ID,
	type GovernanceConfiguration,
	type Proposal,
	proposal,
} from "./transactions.js";

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

/**
 * What a distribution is built for: the period, the reward amounts if they are overridden, and
 * the generator recorded in the manifest.
 */
export type ExportParameters = ExportPeriod & {
	minPayout: bigint;
	generator: Generator;
};

export type Export = {
	/** The package CID. */
	cid: CID;
	/** The CARv1 of the package. */
	car: Uint8Array;
	/** The package directory. */
	dir: string;
	manifest: Manifest;
	allocations: Allocation[];
	proposal: Proposal;
	bundles: ActionBundles;
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

/**
 * Builds the package of a period into `dir`, which must be empty or missing, using `safenet` for
 * the period's rewards, settlement and sanctions, on top of the inputs `exportInputs` reads.
 */
export const exportPackage = async (
	safenet: Safenet,
	config: ExportConfiguration,
	{ period, minPayout, generator, ...overrides }: ExportParameters,
	dir: string,
): Promise<Export> => {
	const withBackoff = backoff({ debug: log });
	const client = config.stakingClient;
	const { stakingChainId, governance, previous, totalRewards, sentinelRewards } =
		await exportInputs(config, { period, ...overrides }, dir);
	const cumulativeMerkleDrop = getAddress(config.cumulativeMerkleDropAddress);

	// In sequence, as each call indexes the period, and the indexers are not safe to run
	// concurrently with themselves.
	const settlement = await safenet.settlement(period);
	const { payouts: validatorPayouts, unpaid } = await safenet.rewards(
		period,
		totalRewards,
		minPayout,
	);
	const { payouts: sentinelPayouts, forfeited } = await safenet.sentinelRewards(
		period,
		sentinelRewards,
	);
	const sanctions = await safenet.pinnedSanctionedAccounts(period);
	const payouts = mergeRewardPayouts(validatorPayouts, sentinelPayouts);

	const kyc = committedKyc();
	const filters = {
		sanctions: sanctions.accounts,
		kycThreshold: kyc.threshold,
		kycApprovals: kyc.accounts,
	};
	const db = new MerkleDb({ root: dir });
	const update = await db.distribute(period, distributionPayouts(payouts), unpaid, filters);
	const index = await db.index();
	if (update === null || index === null) {
		throw new Error(`rewards DB ${previous.cid} rejected period ${period.fromTimestamp}`);
	}

	const stakingBoundary = await blockAtTimestamp(
		client,
		{ timestamp: period.toTimestamp, fromBlock: config.stakingStartBlock ?? 0n },
		withBackoff,
	);
	if (stakingBoundary === null) {
		throw new Error(`period end ${period.toTimestamp} is before the staking start block`);
	}
	const consensusChainId = await withBackoff(() => getChainId(config.consensusClient));
	const safeToken = await safenet.safeToken();

	const { allocations, totals } = buildAllocations({ payouts, unpaid, forfeited }, filters);
	const manifest: Manifest = {
		allocations: totals,
		chains: {
			consensus: {
				boundaryBlock: settlement.boundaryBlock,
				chainId: consensusChainId,
				contracts: {
					consensus: getAddress(config.consensusAddress),
					sentinelOracle: getAddress(config.sentinelOracleAddress),
				},
				settlementBlock: settlement.settlementBlock,
			},
			staking: {
				boundaryBlock: stakingBoundary.number,
				chainId: stakingChainId,
				contracts: {
					delegateRegistry: getAddress(config.delegateRegistryAddress),
					sanctionsList: getAddress(config.sanctionsListAddress),
					staking: getAddress(config.stakingAddress),
				},
			},
		},
		distribution: {
			additionalAmount: update.additionalAmount,
			cumulativeMerkleDrop,
			merkleRoot: update.merkleRoot,
			safeToken,
			tokenTotal: index.tokenTotal,
		},
		generator,
		governance,
		ipfs: IPFS_PARAMETERS,
		kyc: { newlyApproved: update.newlyApproved, threshold: kyc.threshold },
		parameters: { minPayout, sentinelRewards, totalRewards },
		period: { ...period, settlementTimestamp: settlement.settlementTimestamp },
		previous: {
			cid: previous.cid.toString(),
			merkleRoot: previous.merkleRoot,
			rewardsUntil: previous.rewardsUntil,
		},
		sanctions: {
			offchain: {
				...sanctions.offchain,
				repository: config.sanctionsAddressRepo ?? DEFAULT_SANCTIONS_ADDRESS_REPO,
			},
		},
		version: 1,
	};
	await writePackageFiles(dir, { allocations, manifest });
	const { cid, car } = await packDirectory(dir);
	log(`packed ${cid} with Merkle root ${update.merkleRoot}`);

	const proposed = proposal(
		{
			additionalAmount: update.additionalAmount,
			cid,
			cumulativeMerkleDrop,
			merkleRoot: update.merkleRoot,
			safeToken,
		},
		governance,
	);
	const bundles = actionBundles(proposed, governance, settlement.settlementTimestamp);
	return { cid, car, dir, manifest, allocations, proposal: proposed, bundles };
};
