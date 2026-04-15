import { getAbiItem, keccak256, toHex } from "viem";
import { DELEGATE_REGISTRY_ABI } from "../abi.js";
import type { StakingData } from "../data/staking.js";
import type { FromBlock } from "../utils/ranges.js";
import { type BlockTimestamp, type Configuration, EventIndexer, type Log } from "./events.js";
import { VALIDATOR_BENEFICIARIES_SEED_DATA } from "./seeds/validator-beneficiaries.js";

const EVENTS = [
	getAbiItem({ abi: DELEGATE_REGISTRY_ABI, name: "SetDelegate" }),
	getAbiItem({ abi: DELEGATE_REGISTRY_ABI, name: "ClearDelegate" }),
];
const ID = keccak256(toHex("Safenet Beta validator commission beneficiary"));

export class ValidatorBeneficiaries extends EventIndexer<typeof EVENTS, StakingData> {
	constructor(config: Configuration<StakingData>) {
		super({
			name: "validator-beneficiaries",
			events: EVENTS,
			...config,
		});
	}

	protected seed(contract: string, { fromBlock }: FromBlock): BlockTimestamp | null {
		const seedData = VALIDATOR_BENEFICIARIES_SEED_DATA[contract];
		if (seedData === undefined || fromBlock > seedData.lastUpdatedBlock.number) {
			return null;
		}

		return seedData.lastUpdatedBlock;
	}

	protected insertEvent(log: Log<typeof EVENTS>): void {
		// Note that Viem does not support scoping `getLogs` with multiple
		// events on indexed fields. Filter it client-side. This is OK for this
		// particular contract as it is not called very often.
		if (log.args.id !== ID) {
			return;
		}

		this.data.registerBeneficiaryUpdate({
			blockTimestamp: log.blockTimestamp,
			staker: log.args.delegator,
			beneficiary: log.eventName === "SetDelegate" ? log.args.delegate : null,
		});
	}
}
