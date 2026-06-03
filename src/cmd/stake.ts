/**
 * Command to print stake statistics for a given payout period.
 */

import type { Address } from "viem";
import { z } from "zod";
import { Safenet } from "../safenet.js";
import { main, rewardsPeriod } from "../utils/args.js";
import { addressColumn, createPresenter, safeTokenColumn } from "../utils/presentation.js";

type StakeItem = { staker: Address; validator: Address; amount: bigint };

main(
	{
		rewardPeriodStart: z.coerce.bigint().optional(),
		rewardPeriodEnd: z.coerce.bigint().optional(),
	},
	async (args) => {
		const safenet = await Safenet.create(args);
		const period = rewardsPeriod(args);

		const presenter = createPresenter<StakeItem>(
			[
				addressColumn({ header: "Staker", extract: ({ staker }) => staker }),
				addressColumn({ header: "Validator", extract: ({ validator }) => validator }),
				safeTokenColumn({ header: "Average Stake", extract: ({ amount }) => amount }),
			],
			args,
		);
		for await (const { staker, amounts } of safenet.staked(period)) {
			for (const { validator, amount } of amounts) {
				presenter.writeRow({ staker, validator, amount });
			}
		}
		presenter.finish();
	},
);
