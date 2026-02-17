import type { Address, Hex } from "viem";

export type GroupId = Hex;
export type ParticipantId = bigint;

export type Participant = {
	id: ParticipantId;
	address: Address;
};

export type GenesisGroup = {
	id: GroupId;
	participantsRoot: Hex;
	count: number;
	threshold: number;
	context: Hex;
};
