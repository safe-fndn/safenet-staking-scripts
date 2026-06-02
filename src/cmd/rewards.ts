/**
 * Command to print reward payouts for a given payout period.
 */

import { formatUnits, getAddress, parseUnits } from "viem";
import { z } from "zod";
import { MerkleDb } from "../merkledb/index.js";
import { Safenet } from "../safenet.js";
import { main, rewardsPeriod, totalRewardsAmount } from "../utils/args.js";
import { writeTransactionBundle } from "../utils/bundle.js";
import { formatSafeToken } from "../utils/format.js";
import { type ColumnDef, createPresenter } from "../utils/presentation.js";

type PayoutItem = { recipient: string; stakeRewards: bigint; commission: bigint };

main(
	{
		rewardPeriodStart: z.coerce.bigint().optional(),
		rewardPeriodEnd: z.coerce.bigint().optional(),
		totalRewards: z
			.string()
			.transform((v) => parseUnits(v, 18))
			.optional(),
		kycThreshold: z
			.string()
			.transform((v) => parseUnits(v, 18))
			.optional(),
		tsv: z.boolean().optional(),
		record: z.string().optional(),
		cumulativeMerkleDropAddress: z
			.string()
			.transform((v) => getAddress(v))
			.optional(),
		split: z.boolean().optional(),
	},
	async (args) => {
		const safenet = await Safenet.create(args);
		const period = rewardsPeriod(args);
		const totalAmount = await totalRewardsAmount(args);

		const { payouts, unpaid } = await safenet.rewards(period, totalAmount);
		const meetsKyc = (amount: bigint) => !!args.kycThreshold && amount >= args.kycThreshold;

		const amountCols: ColumnDef<PayoutItem>[] = args.split
			? [
					{
						header: "Stake Rewards",
						width: 29,
						align: "right",
						format: ({ stakeRewards }) => formatUnits(stakeRewards, 18),
					},
					{
						header: "Commission",
						width: 29,
						align: "right",
						format: ({ commission }) => formatUnits(commission, 18),
					},
				]
			: [
					{
						header: "Payout",
						width: 29,
						align: "right",
						format: ({ stakeRewards, commission }) => formatUnits(stakeRewards + commission, 18),
					},
				];

		const presenter = createPresenter<PayoutItem>(
			[
				{
					header: "Recipient",
					width: 42,
					format: ({ recipient }) => recipient,
				},
				...amountCols,
				{
					header: "KYC",
					width: 3,
					format: {
						table: ({ stakeRewards, commission }) =>
							meetsKyc(stakeRewards + commission) ? "*" : "",
						tsv: ({ stakeRewards, commission }) =>
							meetsKyc(stakeRewards + commission) ? "TRUE" : "FALSE",
					},
				},
			],
			args,
		);

		for (const [recipient, { stakeRewards, commission }] of Object.entries(payouts)) {
			presenter.writeRow({ recipient, stakeRewards, commission });
		}

		presenter.finish(["Unpaid", formatUnits(unpaid, 18)]);

		if (args.record) {
			const sanctions = await safenet.sanctionedAccounts(period);
			const db = new MerkleDb({ record: args.record });
			const filters = { sanctions, ...args };
			const flatPayouts = Object.fromEntries(
				Object.entries(payouts).map(([addr, { stakeRewards, commission }]) => [
					addr,
					stakeRewards + commission,
				]),
			);
			const update = await db.distribute(period, flatPayouts, unpaid, filters);

			console.log();
			if (update === null) {
				console.warn("WARNING: skipped or already processed reward period, not recording.");
			} else {
				console.log(`Merkle Root:        ${update.merkleRoot}`);
				console.log(`Additional Amount:  ${formatSafeToken(update.additionalAmount).trim()}`);

				if (args.cumulativeMerkleDropAddress !== undefined) {
					const safeTokenAddress = await safenet.safeToken();
					const bundle = await writeTransactionBundle(
						args.record,
						`rewards-${period.toTimestamp}`,
						[
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
							{
								to: safeTokenAddress,
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
					);
					console.log(`Transaction Bundle: ${bundle}`);
				}
			}
		}
	},
);
