import { getAbiItem } from "viem";
import { CONSENSUS_ABI } from "../abi.js";
import { EventIndexer, type Log } from "./events.js";
import type { Staking, StakingIndexerConfiguration } from "./staking.js";

const EVENTS = [getAbiItem({ abi: CONSENSUS_ABI, name: "ValidatorStakerSet" })];

export class ValidatorStakers extends EventIndexer<typeof EVENTS> {
	#staking: Staking;

	constructor({ staking, ...config }: StakingIndexerConfiguration) {
		super({
			name: "validator-stakers",
			events: EVENTS,
			...config,
		});
		this.#staking = staking;
	}

	protected insertEvent(log: Log<typeof EVENTS>): void {
		this.#staking.registerStakerUpdate({
			blockTimestamp: log.blockTimestamp,
			validator: log.args.validator,
			staker: log.args.staker,
		});
	}
}
