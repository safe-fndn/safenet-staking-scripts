/**
 * A file-system Merkle distribution database.
 *
 * This stores cummulative token distributions in a file-system-based database,
 * where each distributee has its own file in a well-defined path.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { type Address, encodePacked, getAddress, type Hex, isHex, keccak256, zeroHash } from "viem";
import { z } from "zod";
import { readJsonFile, writeJsonFile } from "../utils/json.js";
import {
	dateToTimestamp,
	type TimestampRange,
	type ToTimestamp,
	timestampToDate,
} from "../utils/ranges.js";
import { AEGIS_REWARDS_START, BETA_REWARDS_UNTIL } from "../utils/sep.js";
import { sortByAddress } from "../utils/sort.js";
import { MerkleTreeMap } from "./treemap.js";

export type MerkleDbConfiguration = {
	/**
	 * The rewards directory itself, holding `latest.json` and `proofs/`.
	 */
	root: string;
};

export type Update = {
	additionalAmount: bigint;
	merkleRoot: Hex;
};

export type ApprovalsUpdate = Update & {
	/**
	 * The KYC-approved accounts that were not yet flagged as such, sorted by address bytes.
	 */
	newlyApproved: Address[];
};

export type Filters = {
	sanctions: Address[];
	kycThreshold?: bigint;
	/**
	 * The complete list of KYC-approved accounts. It must include every account that is already
	 * flagged as approved, as approvals are never revoked.
	 */
	kycApprovals: Address[];
};

export type Payout = {
	amount: bigint;
	/**
	 * The portion of `amount` funded by the sentinel rewards program. Both programs are paid out
	 * of the same distribution, so this is a split of `amount` and never an addition to it.
	 */
	sentinelAmount: bigint;
};

export type IndexData = {
	/**
	 * Unused, carried over unchanged from the rewards DB pinned at the start of Aegis.
	 */
	epoch: number;
	merkleRoot: Hex;
	tokenTotal: bigint;
	sentinelTokenTotal: bigint;
	unpaidAmount?: bigint;
	rewardsUntil?: Date;
};
type Index = {
	data: IndexData;
	update(value: IndexData): Promise<void>;
};

type DistributionData = {
	cumulativeAmount: bigint;
	kycAmount: bigint;
	sentinelAmount: bigint;
	kyc?: boolean;
	merkleRoot: Hex;
	proof: Hex[] | null;
};
type Distribution = {
	account: Address;
	data: DistributionData;
	update(value: DistributionData): Promise<void>;
};

const zHex = z
	.string()
	.refine((s) => isHex(s))
	.transform((s) => s as Hex);
const zIndexData = z.strictObject({
	epoch: z.number(),
	merkleRoot: zHex,
	tokenTotal: z.coerce.bigint(),
	sentinelTokenTotal: z.coerce.bigint().default(0n),
	unpaidAmount: z.coerce.bigint().optional(),
	rewardsUntil: z.coerce.date().optional(),
});
const zDistributionData = z.strictObject({
	cumulativeAmount: z.coerce.bigint(),
	kycAmount: z.coerce.bigint().default(0n),
	// Entries written before sentinel rewards existed record no sentinel spend, so they load
	// unchanged and contribute nothing to the sentinel total.
	sentinelAmount: z.coerce.bigint().default(0n),
	kyc: z.boolean().optional(),
	merkleRoot: zHex,
	proof: zHex.array().nullable(),
});
const zFileNotFoundError = z.object({ code: z.literal("ENOENT") });

/**
 * Returns the start of the rewards period that must follow one ending at `rewardsUntil`.
 *
 * As per the Safenet Aegis SEP, no rewards are paid for the week between the end of Beta and the
 * start of Aegis, so this is the only gap allowed between two consecutive distributions.
 */
export const nextRewardsStart = (rewardsUntil: bigint): bigint =>
	rewardsUntil === BETA_REWARDS_UNTIL ? AEGIS_REWARDS_START : rewardsUntil;

export class MerkleDb {
	#root: string;

	constructor({ root }: MerkleDbConfiguration) {
		this.#root = root;
	}

	#path(...segments: string[]): string {
		return path.join(this.#root, ...segments);
	}

	#accountPath(account: Address): string {
		// In order to not run into directory file count limits, split the
		// acount files based on the leading 4 bytes.
		const normalized = getAddress(account).toLowerCase();
		const match = /^0x(..)(..)(..)(..)/.exec(normalized);
		if (!match) {
			throw new Error(`unexpected bad address '${account}'`);
		}
		return this.#path("proofs", ...match.slice(1, 5), `${normalized}.json`);
	}

	async #locked<T>(thunk: () => Promise<T>): Promise<T> {
		const lockfile = this.#path(".lock");

		// Open the lock file in `wx` mode: this will create an empty file if it
		// does not exist, and throw an error if it already does. We immediately
		// close it, as we just want an empty file to exist on the FS.
		const handle = await fs.open(lockfile, "wx");
		await handle.close();

		const result = await thunk();

		// Clean up the lock file **ONLY IF EXECUTION WAS SUCCESSFUL**. This
		// prevents leaving the db in a bad state, at the cost of requiring
		// manual intervention to fix.
		await fs.unlink(lockfile);

		return result;
	}

	async #getIndex(): Promise<Index> {
		const filename = this.#path("latest.json");
		const data = await readJsonFile(filename, zIndexData);
		const update = (newData: IndexData) => writeJsonFile(filename, newData);
		return { data, update };
	}

	async index(): Promise<IndexData | null> {
		try {
			const { data } = await this.#getIndex();
			return data;
		} catch (err) {
			if (!zFileNotFoundError.safeParse(err).success) {
				throw err;
			}
			return null;
		}
	}

	async #getDistribution(account: Address): Promise<Distribution> {
		const entry = this.#accountPath(account);
		let data: DistributionData;
		try {
			data = await readJsonFile(entry, zDistributionData);
		} catch (err) {
			if (!zFileNotFoundError.safeParse(err).success) {
				throw err;
			}
			data = {
				cumulativeAmount: 0n,
				kycAmount: 0n,
				sentinelAmount: 0n,
				merkleRoot: zeroHash,
				proof: [],
			};
		}
		const update = async (newData: DistributionData) => {
			await fs.mkdir(path.dirname(entry), { recursive: true });
			await writeJsonFile(entry, newData);
		};
		return { account, data, update };
	}

	/**
	 * Applies the complete list of KYC approvals, returning the accounts that were not flagged
	 * before, sorted by address bytes.
	 */
	async #applyApprovals(accounts: Address[]): Promise<Address[]> {
		// Approvals are sticky, so the approvals must list every account that is already
		// flagged; a missing one means that the list is incomplete.
		const approvals = new Set(accounts.map((account) => getAddress(account)));
		for await (const { account, data } of this.#allDistributions()) {
			if (data.kyc === true && !approvals.has(account)) {
				throw new Error(`KYC-approved account ${account} is missing from the approvals`);
			}
		}

		const newlyApproved = [] as Address[];
		for (const account of approvals) {
			if (await this.#approve(account)) {
				newlyApproved.push(account);
			}
		}
		return sortByAddress(newlyApproved, (account) => account);
	}

	/**
	 * Flags an account as KYC-approved and releases its withheld amount, returning whether it was
	 * not flagged before. An account with no entry gets one with nothing to claim.
	 */
	async #approve(account: Address): Promise<boolean> {
		const { data, update } = await this.#getDistribution(account);
		const newlyApproved = data.kyc !== true;
		data.kyc = true;
		data.cumulativeAmount += data.kycAmount;
		data.kycAmount = 0n;
		await update(data);
		return newlyApproved;
	}

	async #distributeTo(
		{ account, amount, sentinelAmount }: { account: Address } & Payout,
		kycThreshold?: bigint,
	): Promise<void> {
		const { data, update } = await this.#getDistribution(account);
		if (kycThreshold !== undefined && amount >= kycThreshold && data.kyc !== true) {
			data.kycAmount += amount;
		} else {
			data.cumulativeAmount += amount;
		}
		// The sentinel share is tracked whichever bucket the payout lands in, so that it stays
		// a split of the entry's total rather than of the claimable amount.
		data.sentinelAmount += sentinelAmount;
		await update(data);
	}

	async *#allDistributions(): AsyncGenerator<Distribution> {
		for await (const entry of fs.glob(this.#path("proofs", "*", "*", "*", "*", "*.json"))) {
			const account = getAddress(path.basename(entry, ".json"));
			if (entry !== this.#accountPath(account)) {
				// Not an actual distribution entry, skip.
				continue;
			}
			const data = await readJsonFile(entry, zDistributionData);
			const update = (newData: DistributionData) => writeJsonFile(entry, newData);
			yield { account, data, update };
		}
	}

	async #rebuildTree(
		period: Partial<ToTimestamp>,
		unpaid: bigint | undefined,
		sanctions: Address[],
	): Promise<Update> {
		// Re-compute the new distribution merkle tree. The tree always
		// sorts by account addresses to ensure that it is stable.
		const leaves = [] as [Address, Hex][];
		const sanctioned = new Set(sanctions);
		for await (const { account, data } of this.#allDistributions()) {
			if (sanctioned.has(account)) {
				// If the account is sanctioned, exclude it from the Merkle
				// root. This means that if the account has not claimed its
				// rewards before the Merkle root is updated, it will loose
				// access to them. Note that this is only best-effort: it
				// is possible for the sanctioned account to front-run the
				// Merkle root update transaction, but it does provide an
				// avenue for recovering funds from sanctioned accounts if
				// they are not quick enough to withdraw them.
				continue;
			}

			// Check for empty payout amounts and exclude them from the
			// Merkle tree - this can happen if an account has a payout
			// waiting on KYC.
			if (data.cumulativeAmount <= 0n) {
				continue;
			}

			const leaf = keccak256(
				encodePacked(["address", "uint256"], [account, data.cumulativeAmount]),
			);
			leaves.push([account, leaf]);
		}
		const tree = new MerkleTreeMap(sortByAddress(leaves, ([address]) => address));

		// Update the index and distributions Merkle proofs.
		const { data: index, update } = await this.#getIndex();
		const merkleRoot = tree.root();
		const previousTokenTotal = index.tokenTotal;
		index.merkleRoot = merkleRoot;
		index.tokenTotal = 0n;
		index.sentinelTokenTotal = 0n;
		if (unpaid !== undefined) {
			index.unpaidAmount = unpaid;
		}
		if (period.toTimestamp !== undefined) {
			index.rewardsUntil = timestampToDate(period.toTimestamp);
		}
		for await (const { account, data, update } of this.#allDistributions()) {
			index.tokenTotal += data.cumulativeAmount + data.kycAmount;
			index.sentinelTokenTotal += data.sentinelAmount;
			data.merkleRoot = merkleRoot;
			data.proof = tree.proof(account);
			await update(data);
		}

		await update(index);
		return { additionalAmount: index.tokenTotal - previousTokenTotal, merkleRoot };
	}

	distribute(
		period: TimestampRange,
		payouts: Record<Address, Payout>,
		unpaid: bigint,
		filters: Filters,
	): Promise<ApprovalsUpdate | null> {
		return this.#locked<ApprovalsUpdate | null>(async () => {
			// Read the index file, check for common issues such as missing or
			// overlapping rewards periods.
			const index = await this.#getIndex();
			if (index.data.rewardsUntil !== undefined) {
				const timestamp = nextRewardsStart(dateToTimestamp(index.data.rewardsUntil));
				if (timestamp !== period.fromTimestamp || timestamp >= period.toTimestamp) {
					// We are either missing rewards and have a "hole" in our
					// rewards distribution, or there is something wrong with the
					// input period - either way,
					return null;
				}
			}

			// Apply the approvals before the payouts, so that any withheld amounts are released
			// in the same tree rebuild, and the period's payouts to them are not withheld.
			const newlyApproved = await this.#applyApprovals(filters.kycApprovals);

			// Update the distributions with the new payouts.
			for (const key in payouts) {
				const account = getAddress(key);
				await this.#distributeTo({ account, ...payouts[account] }, filters.kycThreshold);
			}

			const update = await this.#rebuildTree(period, unpaid, filters.sanctions);
			return { ...update, newlyApproved };
		});
	}

	/**
	 * Applies the complete list of KYC approvals between two distributions, releasing withheld
	 * amounts without waiting for the next one.
	 */
	kyc(period: ToTimestamp, approvals: Address[], sanctions: Address[]): Promise<ApprovalsUpdate> {
		return this.#locked<ApprovalsUpdate>(async () => {
			// Read the index file, ensure that the KYC update is being done
			// on the correct period.
			const index = await this.#getIndex();
			if (index.data.rewardsUntil !== undefined) {
				const timestamp = dateToTimestamp(index.data.rewardsUntil);
				if (timestamp !== period.toTimestamp) {
					throw new Error("attempt to update KYC status for wrong rewards period");
				}
			}

			const newlyApproved = await this.#applyApprovals(approvals);

			// A KYC update distributes nothing, so the unpaid amount carried forward from the
			// period's distribution is left as is.
			const update = await this.#rebuildTree({}, undefined, sanctions);
			return { ...update, newlyApproved };
		});
	}
}
