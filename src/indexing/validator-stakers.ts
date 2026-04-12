import { getAbiItem } from "viem";
import { CONSENSUS_ABI } from "../abi.js";
import type { StakingData } from "../data/staking.js";
import { type Configuration, EventIndexer, type Log } from "./events.js";

const EVENTS = [getAbiItem({ abi: CONSENSUS_ABI, name: "ValidatorStakerSet" })];

export class ValidatorStakers extends EventIndexer<typeof EVENTS, StakingData> {
	constructor(config: Configuration<StakingData>) {
		super({
			name: "validator-stakers",
			events: EVENTS,
			...config,
		});
	}

	protected insertEvent(log: Log<typeof EVENTS>): void {
		this.data.registerStakerUpdate({
			blockTimestamp: log.blockTimestamp,
			validator: log.args.validator,
			staker: log.args.staker,
		});
	}
}
