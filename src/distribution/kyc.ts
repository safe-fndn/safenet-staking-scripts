/**
 * The KYC threshold and approvals.
 *
 * Both are versioned in `kyc.json` next to this module, which SEF edits manually through reviewed
 * PRs, so that a distribution is reproducible from the commit that produced it. It is imported
 * rather than read at runtime, so it is part of the build.
 */

import { type Address, getAddress, isAddress, parseUnits } from "viem";
import { z } from "zod";
import KYC_JSON from "./kyc.json" with { type: "json" };

export type Kyc = {
	/**
	 * The KYC-approved accounts, checksummed and sorted by address bytes.
	 */
	accounts: Address[];
	/**
	 * The payout amount at or above which a payout to an account that is not KYC-approved is
	 * withheld until it is.
	 */
	threshold: bigint;
};

const zAccount = z
	.string()
	.refine((s) => isAddress(s, { strict: false }) && getAddress(s) === s, {
		message: "expected a checksummed address",
	})
	.transform((s) => s as Address);
/**
 * Refines a list of accounts to be sorted by address bytes with no duplicates.
 */
export const refineSortedAccounts = (accounts: Address[], ctx: z.RefinementCtx): void => {
	for (let i = 1; i < accounts.length; i++) {
		const [previous, current] = [accounts[i - 1].toLowerCase(), accounts[i].toLowerCase()];
		if (previous === current) {
			ctx.addIssue({ code: "custom", message: `duplicate account ${accounts[i]}` });
		} else if (previous > current) {
			ctx.addIssue({ code: "custom", message: `account ${accounts[i]} is not sorted` });
		}
	}
};

/**
 * Checksummed accounts, sorted by address bytes with no duplicates.
 */
export const zSortedAccounts = zAccount.array().superRefine(refineSortedAccounts);
const zKyc = z.strictObject({
	accounts: zSortedAccounts,
	// A decimal amount of SAFE tokens, parsed exactly like the `--kycThreshold` flag.
	threshold: z
		.string()
		.regex(/^\d+(\.\d{1,18})?$/, { message: "expected a decimal SAFE token amount" })
		.transform((s) => parseUnits(s, 18))
		.refine((t) => t > 0n, { message: "expected a positive threshold" }),
});

/**
 * The committed KYC threshold and approvals.
 */
export const kyc = (): Kyc => zKyc.parse(KYC_JSON);
