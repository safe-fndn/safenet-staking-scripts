/**
 * The `manifest.json` of a package: everything a distribution was derived from, so that
 * `cmd:verify` can re-derive it and compare.
 */

import type { Address } from "viem";
import { z } from "zod";
import {
	OFFCHAIN_SOURCES,
	type OffchainSanctions,
	type OffchainSource,
	SNAPSHOT_RELEASE_PATTERN,
} from "../data/sanctions.js";
import type { Settlement } from "../safenet.js";
import { type GitHubRepository, zGitHubRepository } from "../utils/gh.js";
import type { TimestampRange } from "../utils/ranges.js";
import { COMMIT_PATTERN } from "./generator.js";
import { IPFS_PARAMETERS, type IpfsParameters } from "./ipfs.js";
import { zSortedAccounts } from "./kyc.js";
import type { RewardsDb } from "./previous.js";
import {
	type DistributionUpdate,
	type GovernanceConfiguration,
	zBytes32,
	zChecksummedAddress,
	zPackageCid,
	zValue,
} from "./transactions.js";

export type Manifest = {
	allocations: {
		forfeited: bigint;
		unpaid: bigint;
	};
	chains: {
		consensus: Pick<Settlement, "boundaryBlock" | "settlementBlock"> & {
			chainId: number;
			contracts: { consensus: Address; sentinelOracle: Address };
		};
		staking: {
			boundaryBlock: bigint;
			chainId: number;
			contracts: { delegateRegistry: Address; sanctionsList: Address; staking: Address };
		};
	};
	distribution: Omit<DistributionUpdate, "cid"> & {
		tokenTotal: bigint;
	};
	generator: {
		/**
		 * The full git commit hash the package was built from, or `null` when it was built from
		 * source, without a version module.
		 */
		commit: string | null;
		repository: string;
	};
	governance: GovernanceConfiguration;
	ipfs: IpfsParameters;
	kyc: {
		/** The approved accounts that were not flagged in the previous rewards DB, sorted. */
		newlyApproved: Address[];
		threshold: bigint;
	};
	parameters: {
		minPayout: bigint;
		sentinelRewards: bigint;
		totalRewards: bigint;
	};
	period: TimestampRange & Pick<Settlement, "settlementTimestamp">;
	previous: Pick<RewardsDb, "merkleRoot" | "rewardsUntil"> & {
		/** The previous package CID as its CIDv1 base32 string. */
		cid: string;
	};
	sanctions: {
		offchain: OffchainSanctions & { repository: GitHubRepository };
	};
	version: 1;
};

const zChainId = z.number().int().positive();

const zGovernanceConfiguration = z.strictObject({
	answerExpiration: zValue,
	arbitrator: zChecksummedAddress,
	avatar: zChecksummedAddress,
	bondToken: zChecksummedAddress,
	ensName: z.string().min(1),
	ensResolver: zChecksummedAddress,
	minimumBond: zValue,
	module: zChecksummedAddress,
	oracle: zChecksummedAddress,
	questionCooldown: zValue,
	questionTimeout: zValue,
	templateId: zValue,
}) satisfies z.ZodType<GovernanceConfiguration, unknown>;

const zIpfsParameters = z.strictObject({
	car: z.literal(IPFS_PARAMETERS.car),
	chunker: z.literal(IPFS_PARAMETERS.chunker),
	cidVersion: z.literal(IPFS_PARAMETERS.cidVersion),
	hash: z.literal(IPFS_PARAMETERS.hash),
	layout: z.literal(IPFS_PARAMETERS.layout),
	rawLeaves: z.literal(IPFS_PARAMETERS.rawLeaves),
}) satisfies z.ZodType<IpfsParameters, unknown>;

const zSha256 = z.string().regex(/^[0-9a-f]{64}$/, { message: "expected lowercase SHA-256 hex" });

const zOffchainSanctions = z.strictObject({
	release: z.string().regex(SNAPSHOT_RELEASE_PATTERN, { message: "expected a snapshot release" }),
	repository: zGitHubRepository,
	sha256: z.strictObject(
		Object.fromEntries(OFFCHAIN_SOURCES.map((source) => [source, zSha256])) as Record<
			OffchainSource,
			typeof zSha256
		>,
	),
});

/**
 * The `manifest.json` schema. Amounts, blocks and timestamps are decimal strings, addresses are
 * checksummed, hashes are lowercase hex, CIDs are CIDv1 base32 package CIDs, and `ipfs` must be
 * exactly `IPFS_PARAMETERS`. It checks the shape only: `cmd:verify` re-derives the values and
 * compares.
 */
export const zManifest = z.strictObject({
	allocations: z.strictObject({
		forfeited: zValue,
		unpaid: zValue,
	}),
	chains: z.strictObject({
		consensus: z.strictObject({
			boundaryBlock: zValue,
			chainId: zChainId,
			contracts: z.strictObject({
				consensus: zChecksummedAddress,
				sentinelOracle: zChecksummedAddress,
			}),
			settlementBlock: zValue,
		}),
		staking: z.strictObject({
			boundaryBlock: zValue,
			chainId: zChainId,
			contracts: z.strictObject({
				delegateRegistry: zChecksummedAddress,
				sanctionsList: zChecksummedAddress,
				staking: zChecksummedAddress,
			}),
		}),
	}),
	distribution: z.strictObject({
		additionalAmount: zValue,
		cumulativeMerkleDrop: zChecksummedAddress,
		merkleRoot: zBytes32,
		safeToken: zChecksummedAddress,
		tokenTotal: zValue,
	}),
	generator: z.strictObject({
		commit: z
			.string()
			.regex(COMMIT_PATTERN, { message: "expected a full git commit hash" })
			.nullable(),
		repository: z.url(),
	}),
	governance: zGovernanceConfiguration,
	ipfs: zIpfsParameters,
	kyc: z.strictObject({
		newlyApproved: zSortedAccounts,
		threshold: zValue,
	}),
	parameters: z.strictObject({
		minPayout: zValue,
		sentinelRewards: zValue,
		totalRewards: zValue,
	}),
	period: z.strictObject({
		fromTimestamp: zValue,
		settlementTimestamp: zValue,
		toTimestamp: zValue,
	}),
	previous: z.strictObject({
		cid: zPackageCid,
		merkleRoot: zBytes32,
		rewardsUntil: zValue,
	}),
	sanctions: z.strictObject({
		offchain: zOffchainSanctions,
	}),
	version: z.literal(1),
}) satisfies z.ZodType<Manifest, unknown>;
