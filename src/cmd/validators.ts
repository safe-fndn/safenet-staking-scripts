/**
 * Command to print validator statistics for a given payout period.
 */

import { type Address, getAddress } from "viem";
import { z } from "zod";
import { Safenet } from "../safenet.js";
import { main, rewardsPeriod } from "../utils/args.js";
import { addressColumn, createPresenter, safeTokenColumn } from "../utils/presentation.js";

type ValidatorItem = { validator: Address; selfStake: bigint; totalStake: bigint };

main(
	{
		rewardPeriodStart: z.coerce.bigint().optional(),
		rewardPeriodEnd: z.coerce.bigint().optional(),
	},
	async (args) => {
		const safenet = await Safenet.create(args);
		const period = rewardsPeriod(args);

		const validators = await safenet.validatorStats(period);
		const presenter = createPresenter<ValidatorItem>(
			[
				addressColumn({ header: "Validator", extract: ({ validator }) => validator }),
				safeTokenColumn({ header: "Self Stake", extract: ({ selfStake }) => selfStake }),
				safeTokenColumn({ header: "Total Stake", extract: ({ totalStake }) => totalStake }),
			],
			args,
		);
		for (const [validator, { stake }] of Object.entries(validators)) {
			presenter.writeRow({
				validator: getAddress(validator),
				selfStake: stake.self.amount,
				totalStake: stake.total,
			});
		}
		presenter.finish();
	},
);
