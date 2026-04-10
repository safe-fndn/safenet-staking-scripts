import { getAbiItem } from "viem";
import { STAKING_ABI } from "../abi.js";
import { EventIndexer, type Log } from "./events.js";
import type { Staking, StakingIndexerConfiguration } from "./staking.js";

const EVENTS = [getAbiItem({ abi: STAKING_ABI, name: "ValidatorUpdated" })];

export class Validators extends EventIndexer<typeof EVENTS> {
	#staking: Staking;

	constructor({ staking, ...config }: StakingIndexerConfiguration) {
		super({
			name: "validators",
			events: EVENTS,
			...config,
		});
		this.#staking = staking;
	}

	protected insertEvent(log: Log<typeof EVENTS>): void {
		this.#staking.registerValidatorUpdate({
			blockTimestamp: log.blockTimestamp,
			validator: log.args.validator,
			isRegistered: log.args.isRegistered ? 1 : 0,
		});
	}
}
