/**
 * Command to print reward payouts for a given payout period.
 */

import { type Address, formatUnits, getAddress, parseUnits } from "viem";
import { z } from "zod";
import { MerkleDb } from "../merkledb/index.js";
import { mergeRewardPayouts, payoutAmount, Safenet } from "../safenet.js";
import { main, rewardsPeriod, sentinelRewardsAmount, totalRewardsAmount } from "../utils/args.js";
import { writeTransactionBundle } from "../utils/bundle.js";
import { formatSafeToken } from "../utils/format.js";
import {
	addressColumn,
	booleanColumn,
	createPresenter,
	safeTokenColumn,
} from "../utils/presentation.js";

type PayoutItem = {
	recipient: Address;
	stakeRewards: bigint;
	commission: bigint;
	sentinelRewards: bigint;
};

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
		sentinelRewards: z
			.string()
			.transform((v) => parseUnits(v, 18))
			.optional(),
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
		const perSentinelAmount = sentinelRewardsAmount(args);

		// Validator and sentinel rewards are two separate programs, but both are
		// funded from the same treasury Safe and paid out through the same
		// cumulative Merkle drop, so they are merged into a single payouts map
		// here: `MerkleDb.distribute` rebuilds the whole tree and stamps the
		// period as processed, so a second call for the same period would be
		// rejected. The two calls are awaited in sequence rather than with
		// `Promise.all`, as each one indexes the period and the indexers are
		// not safe to run concurrently with themselves.
		const { payouts: validatorPayouts, unpaid } = await safenet.rewards(period, totalAmount);
		const { payouts: sentinelPayouts, forfeited } = await safenet.sentinelRewards(
			period,
			perSentinelAmount,
		);
		const payouts = mergeRewardPayouts(validatorPayouts, sentinelPayouts);

		const meetsKyc = (amount: bigint) => !!args.kycThreshold && amount >= args.kycThreshold;

		const presenter = createPresenter<PayoutItem>(
			[
				addressColumn({
					header: "Recipient",
					extract: ({ recipient }) => recipient,
				}),
				...(args.split
					? [
							safeTokenColumn<PayoutItem>({
								header: "Stake Rewards",
								extract: ({ stakeRewards }) => stakeRewards,
							}),
							safeTokenColumn<PayoutItem>({
								header: "Commission",
								extract: ({ commission }) => commission,
							}),
							safeTokenColumn<PayoutItem>({
								header: "Sentinel Rewards",
								extract: ({ sentinelRewards }) => sentinelRewards,
							}),
						]
					: [
							safeTokenColumn<PayoutItem>({
								header: "Payout",
								extract: payoutAmount,
							}),
						]),
				booleanColumn({
					header: "KYC",
					extract: (item) => meetsKyc(payoutAmount(item)),
				}),
			],
			args,
		);

		for (const [recipient, split] of Object.entries(payouts)) {
			presenter.writeRow({ recipient: getAddress(recipient), ...split });
		}

		// Forfeited sentinel grants are reported separately from the validator
		// `unpaid` amount and not folded into it: `unpaid` is current-period
		// rounding dust that gets carried forward into the next period, whereas
		// a forfeited grant is budget that is simply never spent.
		presenter.finish(
			["Unpaid", formatUnits(unpaid, 18)],
			["Forfeited", formatUnits(forfeited, 18)],
		);

		if (args.record) {
			const sanctions = await safenet.sanctionedAccounts(period);
			const db = new MerkleDb({ record: args.record });
			const filters = { sanctions, ...args };
			// Each entry carries its sentinel share alongside the total it is part
			// of, so that a recipient who is both a validator staker and a
			// sentinel is distributed to once, without losing track of how much
			// of the distribution the sentinel program funded.
			const flatPayouts = Object.fromEntries(
				Object.entries(payouts).map(([addr, split]) => [
					addr,
					{ amount: payoutAmount(split), sentinelAmount: split.sentinelRewards },
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
