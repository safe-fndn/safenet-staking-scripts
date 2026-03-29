import { type Address, getAbiItem } from "viem";
import { COORDINATOR_ABI } from "../abi.js";
import type { Attestations, AttestationsIndexerConfiguration } from "./attestations.js";
import { EventIndexer, type ParsedLog } from "./events.js";

const EVENTS = [
	getAbiItem({ abi: COORDINATOR_ABI, name: "KeyGenConfirmed" }),
	getAbiItem({ abi: COORDINATOR_ABI, name: "Sign" }),
	getAbiItem({ abi: COORDINATOR_ABI, name: "SignShared" }),
	getAbiItem({ abi: COORDINATOR_ABI, name: "SignCompleted" }),
];

export type ParticipationSummary = {
	total: number;
	participants: Record<Address, number>;
};

export class Signatures extends EventIndexer<typeof EVENTS> {
	#attestations: Attestations;

	constructor({ attestations, ...config }: AttestationsIndexerConfiguration) {
		super({
			name: "signatures",
			events: EVENTS,
			...config,
		});
		this.#attestations = attestations;
	}

	protected insertEvent(log: ParsedLog<typeof EVENTS>): void {
		switch (log.eventName) {
			case "KeyGenConfirmed": {
				this.#attestations.registerParticipant({
					address: log.args.participant,
				});
				break;
			}
			case "Sign": {
				this.#attestations.registerSigningCeremony({
					sid: log.args.sid,
					blockNumber: log.blockNumber,
				});
				break;
			}
			case "SignShared": {
				this.#attestations.registerSignatureShare({
					sid: log.args.sid,
					participant: log.args.participant,
					selectionRoot: log.args.selectionRoot,
				});
				break;
			}
			case "SignCompleted": {
				this.#attestations.registerSignatureCompleted({
					sid: log.args.sid,
					selectionRoot: log.args.selectionRoot,
					blockNumber: log.blockNumber,
				});
				break;
			}
		}
	}
}
