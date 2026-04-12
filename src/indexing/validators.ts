import { getAbiItem } from "viem";
import { STAKING_ABI } from "../abi.js";
import type { StakingData } from "../data/staking.js";
import { type Configuration, EventIndexer, type Log } from "./events.js";

const EVENTS = [getAbiItem({ abi: STAKING_ABI, name: "ValidatorUpdated" })];

export class Validators extends EventIndexer<typeof EVENTS, StakingData> {
	constructor(config: Configuration<StakingData>) {
		super({
			name: "validators",
			events: EVENTS,
			...config,
		});
	}

	protected insertEvent(log: Log<typeof EVENTS>): void {
		this.data.registerValidatorUpdate({
			blockTimestamp: log.blockTimestamp,
			validator: log.args.validator,
			isRegistered: log.args.isRegistered ? 1 : 0,
		});
	}
}
