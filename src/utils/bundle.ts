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

export const writeTransactionBundle = async (
	record: string,
	key: string,
	transactions: BundleTransaction[],
): Promise<string> => {
	const txDir = path.join(record, "assets", "rewards", "transactions");
	await fs.mkdir(txDir, { recursive: true });

	const bundle = {
		version: "1.0",
		chainId: "1",
		createdAt: Date.now(),
		meta: {},
		transactions: transactions.map((tx) => ({
			to: tx.to,
			value: tx.value ?? "0",
			data: tx.data ?? null,
			contractMethod: tx.contractMethod ?? null,
			contractInputsValues: tx.contractInputsValues ?? null,
		})),
	};

	const txFile = path.join(txDir, `${key}.json`);
	await writeJsonFile(txFile, bundle);
	return txFile;
};
