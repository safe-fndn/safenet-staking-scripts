import { getAbiItem } from "viem";
import { STAKING_ABI } from "../abi.js";
import type { StakingData } from "../data/staking.js";
import { type Configuration, EventIndexer, type Log } from "./events.js";

const EVENTS = [
	getAbiItem({ abi: STAKING_ABI, name: "StakeIncreased" }),
	getAbiItem({ abi: STAKING_ABI, name: "WithdrawalInitiated" }),
];

export class Stake extends EventIndexer<typeof EVENTS, StakingData> {
	constructor(config: Configuration<StakingData>) {
		super({
			name: "stake",
			events: EVENTS,
			...config,
		});
	}

	protected insertEvent(log: Log<typeof EVENTS>): void {
		// Ideally, we would update the amount in a single query. However,
		// unfortunately, `better-sqlite3` does not build the `decimal`
		// extension into its `sqlite3` bundle, meaning we cannot do arbitrary
		// precision math. Note that `insertEvent` is always executed within a
		// transaction.
		const { blockTimestamp, amount } = this.data.latestStake(log.args) ?? {
			blockTimestamp: 0,
			amount: "0",
		};
		if (BigInt(blockTimestamp) > log.blockTimestamp) {
			throw new Error("event out of order");
		}

		const delta = log.eventName === "StakeIncreased" ? log.args.amount : -log.args.amount;
		const newAmount = BigInt(amount) + delta;
		if (newAmount < 0n) {
			throw new Error("withdrawal overflow");
		}

		this.data.registerStakeChange({
			blockTimestamp: log.blockTimestamp,
			staker: log.args.staker,
			validator: log.args.validator,
			amount: `${newAmount}`,
		});
	}
}
