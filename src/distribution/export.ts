/**
 * The export pipeline: builds a distribution package on top of the ENS-pinned rewards DB.
 *
 * A distribution is a function of the pinned rewards DB, the chain history up to the period's
 * settlement and the inputs versioned with the code. This wires the pieces together:
 *
 * 1. reads the governance configuration and resolves the previous rewards DB at one block, and
 *    derives the period, the two weeks that follow the previous rewards DB;
 * 2. computes the period's validator and sentinel rewards and pins its sanctions;
 * 3. distributes them on top of a copy of the previous rewards DB, with the KYC file, and packs
 *    the package;
 * 4. builds the proposal and its action bundles.
 *
 * Everything is returned in memory; writing release assets is up to the caller.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import debug from "debug";
import type { CID } from "multiformats/cid";
import { type Address, type Client, getAddress, type Hex } from "viem";
import { getBlockNumber, getChainId } from "viem/actions";
import { MerkleDb, nextRewardsStart } from "../merkledb/index.js";
import {
	distributionPayouts,
	mergeRewardPayouts,
	type RewardSplit,
	type Safenet,
	type Settlement,
	SettlementBlockMissingError,
} from "../safenet.js";
import { rewardsPeriod, sentinelRewardsAmount, totalRewardsAmount } from "../utils/args.js";
import { backoff } from "../utils/backoff.js";
import { TimestampAfterLatestBlockError } from "../utils/blocks.js";
import { formatTimestamp } from "../utils/format.js";
import type { GitHubRepository } from "../utils/gh.js";
import type { TimestampRange } from "../utils/ranges.js";
import { type ActionBundles, actionBundles } from "./actions.js";
import { governanceConfiguration } from "./governance.js";
import { packDirectory } from "./ipfs.js";
import { kyc as committedKyc } from "./kyc.js";
import { copyRewardsDb } from "./package.js";
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

/**
 * A distribution built by `exportPackage`: its inputs, what it pays, the package and the proposal.
 */
export type Export = ExportInputs & {
	/** The consensus blocks the period's late-arriving events are cut off at. */
	settlement: Settlement;
	/** The merged validator and sentinel rewards of every account, before any filter. */
	payouts: Record<Address, RewardSplit>;
	/** The part of the validator budget that no validator earned, carried to the next period. */
	unpaid: bigint;
	/** The grants of the sentinels below the participation threshold, which are never paid. */
	forfeited: bigint;
	/** The `data-YYYY-MM-DD` snapshot release the offchain sanctions lists were pinned to. */
	sanctionsRelease: string;
	/** The SAFE that the Cumulative Merkle Drop needs on top of what it already received. */
	additionalAmount: bigint;
	merkleRoot: Hex;
	/** The KYC-approved accounts that this distribution flags for the first time. */
	newlyApproved: Address[];
	/** The package CID. */
	cid: CID;
	/** The CARv1 of the package. */
	car: Uint8Array;
	/** The package directory. */
	dir: string;
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

/**
 * Builds the package of the period that follows the previous rewards DB into `dir`, which must be
 * empty or missing, using `safenet` for the period's rewards, settlement and sanctions, on top of
 * the inputs `exportInputs` reads.
 *
 * There are no overrides: the amounts are those of `exportInputs`, and `minPayout` is 0, so that
 * every account's rewards are distributed in the period they are earned.
 */
export const exportPackage = async (
	safenet: Safenet,
	config: ExportConfiguration,
	dir: string,
): Promise<Export> => {
	const inputs = await exportInputs(config, dir);
	const { governance, previous, period, totalRewards, sentinelRewards } = inputs;
	const cumulativeMerkleDrop = getAddress(config.cumulativeMerkleDropAddress);

	// The period may not have ended or settled yet, which is worth saying in its own terms.
	const settlement = await safenet.settlement(period).catch((error: unknown) => {
		if (
			error instanceof TimestampAfterLatestBlockError ||
			error instanceof SettlementBlockMissingError
		) {
			throw new Error(
				`period ${formatTimestamp(period.fromTimestamp)} → ${formatTimestamp(period.toTimestamp)} ` +
					`after rewards DB ${previous.cid} has not settled yet (${error.message})`,
				{ cause: error },
			);
		}
		throw error;
	});
	// In sequence, as each call indexes the period, and the indexers are not safe to run
	// concurrently with themselves.
	const { payouts: validatorPayouts, unpaid } = await safenet.rewards(period, totalRewards, 0n);
	const { payouts: sentinelPayouts, forfeited } = await safenet.sentinelRewards(
		period,
		sentinelRewards,
	);
	const sanctions = await safenet.pinnedSanctionedAccounts(period);
	const payouts = mergeRewardPayouts(validatorPayouts, sentinelPayouts);

	const kyc = committedKyc();
	const update = await new MerkleDb({ root: dir }).distribute(
		period,
		distributionPayouts(payouts),
		unpaid,
		{ sanctions: sanctions.accounts, kycThreshold: kyc.threshold, kycApprovals: kyc.accounts },
	);
	if (update === null) {
		throw new Error(`rewards DB ${previous.cid} rejected period ${period.fromTimestamp}`);
	}
	const { cid, car } = await packDirectory(dir);
	log(`packed ${cid} with Merkle root ${update.merkleRoot}`);

	// Read at the latest block: the token is immutable in the staking contract.
	const safeToken = await safenet.safeToken();
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
	return {
		...inputs,
		settlement,
		payouts,
		unpaid,
		forfeited,
		sanctionsRelease: sanctions.release,
		additionalAmount: update.additionalAmount,
		merkleRoot: update.merkleRoot,
		newlyApproved: update.newlyApproved,
		cid,
		car,
		dir,
		proposal: proposed,
		bundles,
	};
};
