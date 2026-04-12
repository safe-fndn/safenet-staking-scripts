import { type Address, getAbiItem } from "viem";
import { COORDINATOR_ABI } from "../abi.js";
import type { AttestationData } from "../data/attestations.js";
import { type Configuration, EventIndexer, type Log } from "./events.js";

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

export class Signatures extends EventIndexer<typeof EVENTS, AttestationData> {
	constructor(config: Configuration<AttestationData>) {
		super({
			name: "signatures",
			events: EVENTS,
			...config,
		});
	}

	protected insertEvent(log: Log<typeof EVENTS>): void {
		switch (log.eventName) {
			case "KeyGenConfirmed": {
				this.data.registerParticipant({
					address: log.args.participant,
				});
				break;
			}
			case "Sign": {
				this.data.registerSigningCeremony({
					sid: log.args.sid,
				});
				break;
			}
			case "SignShared": {
				this.data.registerSignatureShare({
					sid: log.args.sid,
					participant: log.args.participant,
					selectionRoot: log.args.selectionRoot,
				});
				break;
			}
			case "SignCompleted": {
				this.data.registerSignatureCompleted({
					sid: log.args.sid,
					selectionRoot: log.args.selectionRoot,
					blockTimestamp: log.blockTimestamp,
				});
				break;
			}
		}
	}
}
