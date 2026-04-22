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
import { sortByAddress } from "../utils/sort.js";
import { MerkleTreeMap } from "./treemap.js";

export type MerkleDbConfiguration = {
	record: string;
};

export type Update = {
	additionalAmount: bigint;
	merkleRoot: Hex;
};

export type Filters = {
	sanctions: Address[];
	kycThreshold?: bigint;
};

type IndexData = {
	merkleRoot: Hex;
	tokenTotal: bigint;
	unpaidAmount?: bigint;
	updatedAt: Date;
	rewardsUntil?: Date;
};
type Index = {
	data: IndexData;
	update(value: IndexData): Promise<void>;
};

type DistributionData = {
	cumulativeAmount: bigint;
	kycAmount: bigint;
	kyc?: boolean;
	merkleRoot: Hex;
	proof: Hex[] | null;
	[k: string]: unknown;
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
const zIndexData = z.looseObject({
	merkleRoot: zHex,
	tokenTotal: z.coerce.bigint(),
	unpaidAmount: z.coerce.bigint().optional(),
	updatedAt: z.coerce.date(),
	rewardsUntil: z.coerce.date().optional(),
});
const zDistributionData = z.looseObject({
	cumulativeAmount: z.coerce.bigint(),
	kycAmount: z.coerce.bigint().default(0n),
	kyc: z.boolean().optional(),
	merkleRoot: zHex,
	proof: zHex.array().nullable(),
});
const zFileNotFoundError = z.object({ code: z.literal("ENOENT") });

export class MerkleDb {
	#root: string;

	constructor({ record }: MerkleDbConfiguration) {
		this.#root = path.join(record, "assets", "rewards");
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

	async #distributeTo(
		{ account, amount }: { account: Address; amount: bigint },
		kycThreshold?: bigint,
	): Promise<void> {
		const { data, update } = await this.#getDistribution(account);
		if (kycThreshold !== undefined && amount >= kycThreshold && data.kyc !== true) {
			data.kycAmount += amount;
		} else {
			data.cumulativeAmount += amount;
		}
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
		unpaid: bigint,
		sanctions: Address[],
	): Promise<Update> {
		// Re-compute the new distribution merkle tree. The tree always
		// sorts by account addresses to ensure that it is stable.
		const leaves = [] as [Address, Hex][];
		const sanctioned = new Set(sanctions);
		for await (const { account, data, update } of this.#allDistributions()) {
			if (data.kyc === true && data.kycAmount > 0n) {
				data.cumulativeAmount += data.kycAmount;
				data.kycAmount = 0n;
				await update(data);
			}

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
		index.unpaidAmount = (index.unpaidAmount ?? 0n) + unpaid;
		index.updatedAt = new Date();
		if (period.toTimestamp !== undefined) {
			index.rewardsUntil = timestampToDate(period.toTimestamp);
		}
		for await (const { account, data, update } of this.#allDistributions()) {
			index.tokenTotal += data.cumulativeAmount + data.kycAmount;
			data.merkleRoot = merkleRoot;
			data.proof = tree.proof(account);
			await update(data);
		}

		await update(index);
		return { additionalAmount: index.tokenTotal - previousTokenTotal, merkleRoot };
	}

	distribute(
		period: TimestampRange,
		payouts: Record<Address, bigint>,
		unpaid: bigint,
		filters: Filters,
	): Promise<Update | null> {
		return this.#locked<Update | null>(async () => {
			// Read the index file, check for common issues such as missing or
			// overlapping rewards periods.
			const index = await this.#getIndex();
			if (index.data.rewardsUntil !== undefined) {
				const timestamp = dateToTimestamp(index.data.rewardsUntil);
				if (timestamp !== period.fromTimestamp || timestamp >= period.toTimestamp) {
					// We are either missing rewards and have a "hole" in our
					// rewards distribution, or there is something wrong with the
					// input period - either way,
					return null;
				}
			}

			// Update the distributions with the new payouts.
			for (const key in payouts) {
				const account = getAddress(key);
				await this.#distributeTo({ account, amount: payouts[account] }, filters.kycThreshold);
			}

			return await this.#rebuildTree(period, unpaid, filters.sanctions);
		});
	}

	kyc(period: ToTimestamp, accounts: Address[], sanctions: Address[]): Promise<Update> {
		return this.#locked<Update>(async () => {
			// Read the index file, ensure that the KYC update is being done
			// on the correct period.
			const index = await this.#getIndex();
			if (index.data.rewardsUntil !== undefined) {
				const timestamp = dateToTimestamp(index.data.rewardsUntil);
				if (timestamp !== period.toTimestamp) {
					throw new Error("attempt to update KYC status for wrong rewards period");
				}
			}

			for (const account of accounts) {
				const { data, update } = await this.#getDistribution(account);
				data.kyc = true;
				data.cumulativeAmount += data.kycAmount;
				data.kycAmount = 0n;
				await update(data);
			}

			return await this.#rebuildTree({}, 0n, sanctions);
		});
	}
}
