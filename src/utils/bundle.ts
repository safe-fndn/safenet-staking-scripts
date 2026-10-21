import { promises as fs } from "node:fs";
import path from "node:path";
import type { Address, Hex } from "viem";
import { writeJsonFile } from "./json.js";

export type BundleTransaction = {
	to: Address;
	value?: string;
} & (
	| {
			data: Hex;
			contractMethod?: undefined;
			contractInputsValues?: undefined;
	  }
	| {
			data?: undefined;
			contractMethod?: {
				inputs: {
					name: string;
					type: string;
					internalType: string;
				}[];
				name: string;
				payable: boolean;
			};
			contractInputsValues?: Record<string, unknown>;
	  }
);

export type TransactionBundle = {
	version: "1.0";
	chainId: "1";
	createdAt: number;
	meta: Record<string, never>;
	transactions: {
		to: Address;
		value: string;
		data: Hex | null;
		contractMethod: NonNullable<BundleTransaction["contractMethod"]> | null;
		contractInputsValues: Record<string, unknown> | null;
	}[];
};

/**
 * Builds a Safe Transaction Builder bundle for Ethereum mainnet.
 *
 * The bundle is a pure function of its inputs, so `createdAt` (in milliseconds since the Unix
 * epoch) is passed in rather than read from the clock.
 */
export const transactionBundle = (
	transactions: BundleTransaction[],
	createdAt: number,
): TransactionBundle => ({
	version: "1.0",
	chainId: "1",
	createdAt,
	meta: {},
	transactions: transactions.map((tx) => ({
		to: tx.to,
		value: tx.value ?? "0",
		data: tx.data ?? null,
		contractMethod: tx.contractMethod ?? null,
		contractInputsValues: tx.contractInputsValues ?? null,
	})),
});

/**
 * Writes a Safe Transaction Builder bundle to `<dir>/<key>.json`, created at the current time.
 */
export const writeTransactionBundle = async (
	dir: string,
	key: string,
	transactions: BundleTransaction[],
): Promise<string> => {
	await fs.mkdir(dir, { recursive: true });
	const txFile = path.join(dir, `${key}.json`);
	await writeJsonFile(txFile, transactionBundle(transactions, Date.now()));
	return txFile;
};
