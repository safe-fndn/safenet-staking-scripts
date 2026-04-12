import { getAbiItem } from "viem";
import { SANCTIONS_LIST_ABI } from "../abi.js";
import type { StakingData } from "../data/staking.js";
import type { FromBlock } from "../utils/ranges.js";
import { type BlockTimestamp, type Configuration, EventIndexer, type Log } from "./events.js";
import { SANCTIONS_LIST_SEED_DATA } from "./seeds/sanctions.js";

const EVENTS = [
	getAbiItem({ abi: SANCTIONS_LIST_ABI, name: "SanctionedAddressesAdded" }),
	getAbiItem({ abi: SANCTIONS_LIST_ABI, name: "SanctionedAddressesRemoved" }),
];

export class Sanctions extends EventIndexer<typeof EVENTS, StakingData> {
	constructor(config: Configuration<StakingData>) {
		super({
			name: "sanctions",
			events: EVENTS,
			...config,
		});
	}

	#insertEvent(log: Log<typeof EVENTS>): void {
		switch (log.eventName) {
			case "SanctionedAddressesAdded": {
				for (const account of log.args.addrs) {
					this.data.registerSanction({
						blockTimestamp: log.blockTimestamp,
						account,
						sanctioned: true,
					});
				}
				break;
			}
			case "SanctionedAddressesRemoved": {
				for (const account of log.args.addrs) {
					this.data.registerSanction({
						blockTimestamp: log.blockTimestamp,
						account,
						sanctioned: false,
					});
				}
				break;
			}
		}
	}

	protected seed(contract: string, { fromBlock }: FromBlock): BlockTimestamp | null {
		const seedData = SANCTIONS_LIST_SEED_DATA[contract];
		if (seedData === undefined || fromBlock > seedData.lastUpdatedBlock.number) {
			return null;
		}

		for (const log of seedData.events) {
			if (log.blockTimestamp >= fromBlock) {
				this.#insertEvent(log);
			}
		}
		return seedData.lastUpdatedBlock;
	}

	protected insertEvent(log: Log<typeof EVENTS>): void {
		this.#insertEvent(log);
	}
}
