import { getAbiItem } from "viem";
import { CONSENSUS_ABI } from "../abi.js";
import type { Attestations, AttestationsIndexerConfiguration } from "./attestations.js";
import { EventIndexer, type Log } from "./events.js";

const EVENTS = [
	getAbiItem({ abi: CONSENSUS_ABI, name: "TransactionProposed" }),
	getAbiItem({ abi: CONSENSUS_ABI, name: "TransactionAttested" }),
];

export class Transactions extends EventIndexer<typeof EVENTS> {
	#attestations: Attestations;

	constructor({ attestations, ...config }: AttestationsIndexerConfiguration) {
		super({
			name: "transactions",
			events: EVENTS,
			...config,
		});
		this.#attestations = attestations;
	}

	protected insertEvent(log: Log<typeof EVENTS>): void {
		switch (log.eventName) {
			case "TransactionProposed": {
				this.#attestations.registerTransactionProposal();
				break;
			}
			case "TransactionAttested": {
				this.#attestations.registerTransactionAttestation({
					sid: log.args.signatureId,
				});
				break;
			}
		}
	}
}
