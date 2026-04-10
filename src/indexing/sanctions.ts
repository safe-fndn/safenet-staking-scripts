import { getAbiItem } from "viem";
import { SANCTIONS_LIST_ABI } from "../abi.js";
import type { FromBlock } from "../utils/ranges.js";
import { type BlockTimestamp, EventIndexer, type Log } from "./events.js";
import { SANCTIONS_LIST_SEED_DATA } from "./seeds/sanctions.js";
import type { Staking, StakingIndexerConfiguration } from "./staking.js";

const EVENTS = [
	getAbiItem({ abi: SANCTIONS_LIST_ABI, name: "SanctionedAddressesAdded" }),
	getAbiItem({ abi: SANCTIONS_LIST_ABI, name: "SanctionedAddressesRemoved" }),
];

export class Sanctions extends EventIndexer<typeof EVENTS> {
	#staking: Staking;

	constructor({ staking, ...config }: StakingIndexerConfiguration) {
		super({
			name: "sanctions",
			events: EVENTS,
			...config,
		});
		this.#staking = staking;
	}

	#insertEvent(log: Log<typeof EVENTS>): void {
		switch (log.eventName) {
			case "SanctionedAddressesAdded": {
				for (const account of log.args.addrs) {
					this.#staking.registerSanction({
						blockTimestamp: log.blockTimestamp,
						account,
						sanctioned: true,
					});
				}
				break;
			}
			case "SanctionedAddressesRemoved": {
				for (const account of log.args.addrs) {
					this.#staking.registerSanction({
						blockTimestamp: log.blockTimestamp,
						account,
						sanctioned: true,
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
