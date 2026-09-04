import { getAbiItem, getAddress } from "viem";
import { SENTINEL_ORACLE_ABI } from "../abi.js";
import type { SentinelData } from "../data/sentinels.js";
import { type Configuration, EventIndexer, type Log } from "./events.js";

const EVENTS = [
	getAbiItem({ abi: SENTINEL_ORACLE_ABI, name: "NewRequest" }),
	getAbiItem({ abi: SENTINEL_ORACLE_ABI, name: "Revealed" }),
];

export class SentinelOracle extends EventIndexer<typeof EVENTS, SentinelData> {
	#contract: string;

	constructor(config: Configuration<SentinelData>) {
		super({
			name: "sentinel-oracle",
			events: EVENTS,
			...config,
		});

		// This must match the contract identifier that `EventIndexer` computes
		// for its own bookkeeping, as it is what scopes requests to an oracle.
		// Note that `EventIndexer` already refuses to run against a database
		// that was indexed for a different contract, so the requests stored
		// under this identifier can only ever come from this oracle.
		this.#contract = `${config.chainId}:${getAddress(config.address)}`;
		this.data.registerOracle({ contract: this.#contract });
	}

	protected insertEvent(log: Log<typeof EVENTS>): void {
		switch (log.eventName) {
			case "NewRequest": {
				this.data.registerRequest({
					contract: this.#contract,
					requestId: log.args.requestId,
					blockTimestamp: log.blockTimestamp,
				});
				break;
			}
			case "Revealed": {
				// The `reason` string is deliberately discarded, keeping the
				// database small; only whether a sentinel revealed at all
				// matters for participation.
				this.data.registerReveal({
					contract: this.#contract,
					requestId: log.args.requestId,
					sentinel: log.args.sentinel,
					approved: log.args.approved,
				});
				break;
			}
		}
	}
}
