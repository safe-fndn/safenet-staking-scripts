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
import { type TimestampRange, timestampToDate } from "../utils/ranges.js";
import { sortByAddress } from "../utils/sort.js";
import { MerkleTreeMap } from "./treemap.js";

export type MerkleDbConfiguration = {
	record: string;
};

type DistributionData = {
	cumulativeAmount: bigint;
	merkleRoot: Hex;
	proof: Hex[];
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
const zIndex = z.looseObject({
	merkleRoot: zHex,
	tokenTotal: z.coerce.bigint(),
	updatedAt: z.coerce.date(),
	rewardsUntil: z.coerce.date().optional(),
});
const zDistributionData = z.looseObject({
	cumulativeAmount: z.coerce.bigint(),
	merkleRoot: zHex,
	proof: zHex.array(),
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

	async #locked<T>(thunk: () => Promise<T | null>): Promise<T | null> {
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

	async #distributeTo({ account, amount }: { account: Address; amount: bigint }): Promise<void> {
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
				merkleRoot: zeroHash,
				proof: [],
			};
		}
		data.cumulativeAmount += amount;
		await writeJsonFile(entry, data);
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

	distribute(period: TimestampRange, payouts: Record<Address, bigint>): Promise<Hex | null> {
		return this.#locked(async () => {
			// Read the index file, check for common issues such as missing or
			// overlapping rewards periods.
			const indexfile = this.#path("latest.json");
			const index = await readJsonFile(indexfile, zIndex);
			if (index.rewardsUntil !== undefined) {
				const timestamp = BigInt(index.rewardsUntil.getTime()) / 1000n;
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
				await this.#distributeTo({ account, amount: payouts[account] });
			}

			// Re-compute the new distribution merkle tree. The tree always
			// sorts by account addresses to ensure that it is stable.
			const leaves = [] as [Address, Hex][];
			for await (const { account, data } of this.#allDistributions()) {
				const leaf = keccak256(
					encodePacked(["address", "uint256"], [account, data.cumulativeAmount]),
				);
				leaves.push([account, leaf]);
			}
			const tree = new MerkleTreeMap(sortByAddress(leaves, ([address]) => address));

			// Update the index and distributions.
			index.merkleRoot = tree.root();
			index.tokenTotal = 0n;
			index.updatedAt = new Date();
			index.rewardsUntil = timestampToDate(period.toTimestamp);
			for await (const { account, data, update } of this.#allDistributions()) {
				index.tokenTotal += data.cumulativeAmount;
				data.merkleRoot = tree.root();
				data.proof = tree.proof(account);
				update(data);
			}

			await writeJsonFile(indexfile, index);
			return tree.root();
		});
	}
}
