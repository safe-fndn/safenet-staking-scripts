import {
	type Address,
	encodeAbiParameters,
	encodePacked,
	type Hex,
	keccak256,
	numberToHex,
	parseAbiParameters,
	zeroHash,
} from "viem";
import { calculateParticipantsRoot } from "./merkle.js";
import type { GenesisGroup, Participant } from "./types.js";

export const calcTreshold = (participantCount: number): number => {
	return Math.floor(participantCount / 2) + 1;
};

export const calcGroupContext = (consensus: Address, epoch: bigint): Hex => {
	// 4 bytes version, 20 bytes address, 8 bytes epoch number
	return encodePacked(["uint32", "address", "uint64"], [0, consensus, epoch]);
};

export const calcGroupId = (participantsRoot: Hex, count: number, threshold: number, context: Hex): Hex => {
	const infoHash = BigInt(
		keccak256(
			encodeAbiParameters(parseAbiParameters("bytes32, uint16, uint16, bytes32"), [
				participantsRoot,
				count,
				threshold,
				context,
			]),
		),
	);
	return numberToHex(infoHash & 0xffffffffffffffffffffffffffffffffffffffffffffffff0000000000000000n, { size: 32 });
};

export const calcGenesisGroup = ({
	participants,
	genesisSalt = zeroHash,
}: {
	participants: Participant[];
	genesisSalt?: Hex;
}): GenesisGroup => {
	const participantsRoot = calculateParticipantsRoot(participants);
	const count = participants.length;
	const threshold = calcTreshold(participants.length);
	// For genesis, we don't know the consensus contract address since it
	// depends on the genesis group ID (🐓 and 🥚 problem). Instead, compute a
	// different context based on the user-provided genesis salt (allowing the
	// genesis group ID to be parameterized and the same validator set to work
	// for multiple consensus contracts without needing to rotate the validator
	// accounts).
	const context =
		genesisSalt === zeroHash ? zeroHash : keccak256(encodePacked(["string", "bytes32"], ["genesis", genesisSalt]));
	return {
		id: calcGroupId(participantsRoot, count, threshold, context),
		participantsRoot,
		count,
		threshold,
		context,
	};
};
