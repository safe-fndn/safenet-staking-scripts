import { getAbiItem } from "viem";
import { CONSENSUS_ABI } from "../abi.js";
import type { AttestationData } from "../data/attestations.js";
import { type Configuration, EventIndexer, type Log } from "./events.js";

const EVENTS = [
	getAbiItem({ abi: CONSENSUS_ABI, name: "TransactionProposed" }),
	getAbiItem({ abi: CONSENSUS_ABI, name: "TransactionAttested" }),
];

export class Transactions extends EventIndexer<typeof EVENTS, AttestationData> {
	constructor(config: Configuration<AttestationData>) {
		super({
			name: "transactions",
			events: EVENTS,
			...config,
		});
	}

	protected insertEvent(log: Log<typeof EVENTS>): void {
		switch (log.eventName) {
			case "TransactionProposed": {
				this.data.registerTransactionProposal();
				break;
			}
			case "TransactionAttested": {
				this.data.registerTransactionAttestation({
					sid: log.args.signatureId,
				});
				break;
			}
		}
	}
}
