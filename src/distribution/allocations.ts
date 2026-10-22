/**
 * The `allocations.json` of a package: this period's payout to each recipient, and what happened
 * to it.
 */

import { type Address, getAddress } from "viem";
import { z } from "zod";
import type { Filters } from "../merkledb/index.js";
import type { RewardSplit } from "../safenet.js";
import { sortByAddress } from "../utils/sort.js";
import { refineSortedAccounts } from "./kyc.js";
import type { Manifest } from "./manifest.js";
import { zChecksummedAddress, zValue } from "./transactions.js";

/**
 * What `MerkleDb.distribute` does with a payout:
 * - `sanctioned`: the account is sanctioned, so it is left out of the Merkle tree and cannot
 *   claim, whether or not the payout is also withheld;
 * - `kyc-withheld`: the payout is at or above the KYC threshold and the account is not
 *   KYC-approved, so it is added to the account's `kycAmount` instead of its claimable amount;
 * - `paid`: the payout is added to the account's claimable `cumulativeAmount`.
 */
export type AllocationStatus = "paid" | "kyc-withheld" | "sanctioned";

export type Allocation = RewardSplit & {
	account: Address;
	status: AllocationStatus;
};

export type Allocations = {
	/** The `allocations.json` entries, sorted by address bytes. */
	allocations: Allocation[];
	/** The manifest's `allocations` block. */
	totals: Manifest["allocations"];
};

/**
 * Builds a period's allocations from its merged validator and sentinel payouts (as passed to
 * `MerkleDb.distribute`, see `mergeRewardPayouts`), the validator rewards' `unpaid` amount, the
 * forfeited sentinel grants, and the same filters `MerkleDb.distribute` is called with.
 */
export const buildAllocations = (
	{
		payouts,
		unpaid,
		forfeited,
	}: { payouts: Record<Address, RewardSplit>; unpaid: bigint; forfeited: bigint },
	{ sanctions, kycThreshold, kycApprovals }: Filters,
): Allocations => {
	const sanctioned = new Set(sanctions.map((account) => getAddress(account)));
	const approved = new Set(kycApprovals.map((account) => getAddress(account)));
	const status = (account: Address, amount: bigint): AllocationStatus => {
		if (sanctioned.has(account)) {
			return "sanctioned";
		}
		if (kycThreshold !== undefined && amount >= kycThreshold && !approved.has(account)) {
			return "kyc-withheld";
		}
		return "paid";
	};

	const allocations = Object.entries(payouts).map(
		([key, { commission, sentinelRewards, stakeRewards }]): Allocation => {
			const account = getAddress(key);
			const amount = stakeRewards + commission + sentinelRewards;
			return {
				account,
				commission,
				sentinelRewards,
				stakeRewards,
				status: status(account, amount),
			};
		},
	);
	return {
		allocations: sortByAddress(allocations, ({ account }) => account),
		totals: { forfeited, unpaid },
	};
};

/**
 * The `allocations.json` schema: amounts are decimal strings, accounts are checksummed and the
 * entries are sorted by address bytes with no duplicates.
 */
export const zAllocations = z
	.array(
		z.strictObject({
			account: zChecksummedAddress,
			commission: zValue,
			sentinelRewards: zValue,
			stakeRewards: zValue,
			status: z.enum(["paid", "kyc-withheld", "sanctioned"]),
		}),
	)
	.superRefine((allocations, ctx) =>
		refineSortedAccounts(
			allocations.map(({ account }) => account),
			ctx,
		),
	) satisfies z.ZodType<Allocation[], unknown>;
