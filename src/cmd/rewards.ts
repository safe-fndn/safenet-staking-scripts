/**
 * Command to print reward payouts for a given payout period.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { parseUnits } from "viem";
import { z } from "zod";
import { MerkleDb } from "../merkledb/index.js";
import { Safenet } from "../safenet.js";
import { main, rewardsPeriod } from "../utils/args.js";
import { formatSafeToken } from "../utils/format.js";
import { writeJsonFile } from "../utils/json.js";

main(
	{
		rewardPeriodStart: z.coerce.bigint().optional(),
		rewardPeriodEnd: z.coerce.bigint().optional(),
		totalRewards: z.string().transform((v) => parseUnits(v, 18)),
		record: z.string().optional(),
		cumulativeMerkleDropAddress: z.string().optional(),
	},
	async (args) => {
		const safenet = await Safenet.create(args);
		const period = rewardsPeriod(args);

		const { payouts, unpaid } = await safenet.rewards(period, args.totalRewards);

		console.log(` Recipient                                  | Payout                        `);
		console.log(`--------------------------------------------+-------------------------------`);
		for (const [recipient, amount] of Object.entries(payouts)) {
			console.log(` ${recipient} | ${formatSafeToken(amount)}`);
		}
		console.log(`--------------------------------------------+-------------------------------`);
		console.log(` ${"Unpaid".padEnd(42)} | ${formatSafeToken(unpaid)}`);

		if (args.record) {
			const db = new MerkleDb({ record: args.record });
			const update = await db.distribute(period, payouts, unpaid);

			console.log();
			if (update === null) {
				console.warn("WARNING: skipped or already processed reward period, not recording.");
			} else {
				console.log(`Merkle Root:        ${update.merkleRoot}`);
				console.log(`Additional Amount:  ${formatSafeToken(update.additionalAmount).trim()}`);

				if (args.cumulativeMerkleDropAddress !== undefined) {
					const safeTokenAddress = await safenet.safeToken();
					const txDir = path.join(args.record, "assets", "rewards", "transactions");
					await fs.mkdir(txDir, { recursive: true });

					const bundle = {
						version: "1.0",
						chainId: "1",
						createdAt: Date.now(),
						meta: {},
						transactions: [
							{
								to: args.cumulativeMerkleDropAddress,
								value: "0",
								data: null,
								contractMethod: {
									inputs: [
										{
											name: "merkleRoot_",
											type: "bytes32",
											internalType: "bytes32",
										},
									],
									name: "setMerkleRoot",
									payable: false,
								},
								contractInputsValues: {
									merkleRoot_: update.merkleRoot,
								},
							},
							{
								to: safeTokenAddress,
								value: "0",
								data: null,
								contractMethod: {
									inputs: [
										{
											name: "to",
											type: "address",
											internalType: "address",
										},
										{
											name: "amount",
											type: "uint256",
											internalType: "uint256",
										},
									],
									name: "transfer",
									payable: false,
								},
								contractInputsValues: {
									to: args.cumulativeMerkleDropAddress,
									amount: update.additionalAmount,
								},
							},
						],
					};

					const txFile = path.join(txDir, `rewards-${period.toTimestamp}.json`);
					await writeJsonFile(txFile, bundle);
					console.log(`Transaction Bundle: ${txFile}`);
				}
			}
		}
	},
);
