/**
 * Command to apply the committed KYC approvals and rebuild the Merkle tree between distributions.
 */

import { z } from "zod";
import { AEGIS, AEGIS_PARAMETERS } from "../config/aegis.js";
import { kyc } from "../distribution/kyc.js";
import { MerkleDb } from "../merkledb/index.js";
import { Safenet } from "../safenet.js";
import { main, recordRewardsDirectory, rewardsPeriod } from "../utils/args.js";
import { writeTransactionBundle } from "../utils/bundle.js";

main(
	{
		rewardPeriodEnd: z.coerce.bigint().optional(),
		record: z.string(),
		transactions: z.string().optional(),
	},
	async (args) => {
		const safenet = await Safenet.create({ ...args, ...AEGIS_PARAMETERS });
		const period = rewardsPeriod(args);

		const db = new MerkleDb({ root: recordRewardsDirectory(args.record) });
		const sanctions = await safenet.sanctionedAccounts(period);
		const previous = await db.index();
		const update = await db.kyc(period, kyc().accounts, sanctions);
		console.log(`Merkle Root:        ${update.merkleRoot}`);
		if (update.newlyApproved.length === 0) {
			console.log("No new KYC approvals.");
		}
		for (const account of update.newlyApproved) {
			console.log(`New KYC Approval:   ${account}`);
		}

		// The root can change without new approvals, for example when an account is newly
		// sanctioned, and stay the same with them, when they had nothing withheld.
		if (update.merkleRoot === previous?.merkleRoot) {
			console.log("Merkle root unchanged, no transaction needed.");
		} else if (args.transactions !== undefined) {
			const bundle = await writeTransactionBundle(args.transactions, `kyc-${period.toTimestamp}`, [
				{
					to: AEGIS.ethereum.cumulativeMerkleDrop,
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
