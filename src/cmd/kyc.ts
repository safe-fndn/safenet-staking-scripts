/**
 * Command to mark distribution recipients as KYC approved and rebuild the Merkle tree.
 */

import { getAddress } from "viem";
import { z } from "zod";
import { MerkleDb } from "../merkledb/index.js";
import { Safenet } from "../safenet.js";
import { main, rewardsPeriod } from "../utils/args.js";
import { writeTransactionBundle } from "../utils/bundle.js";

main(
	{
		rewardPeriodEnd: z.coerce.bigint().optional(),
		record: z.string(),
		positionals: z.array(z.string().transform((v) => getAddress(v))).min(1),
		cumulativeMerkleDropAddress: z
			.string()
			.transform((v) => getAddress(v))
			.optional(),
	},
	async (args) => {
		const safenet = await Safenet.create(args);
		const period = rewardsPeriod(args);

		const db = new MerkleDb({ record: args.record });
		const sanctions = await safenet.sanctionedAccounts(period);
		const update = await db.kyc(period, args.positionals, sanctions);
		console.log(`Merkle Root:        ${update.merkleRoot}`);

		if (args.cumulativeMerkleDropAddress !== undefined) {
			const bundle = await writeTransactionBundle(args.record, `kyc-${period.toTimestamp}`, [
				{
					to: args.cumulativeMerkleDropAddress,
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
			]);
			console.log(`Transaction Bundle: ${bundle}`);
		}
	},
);
