import type { ConsensusChainEvent } from "./scenario.js";
import {
	namedAddress,
	requestId,
	safeTxHash,
	selectionRoot,
	signatureId,
	transaction,
	transactionProposalMessage,
} from "./utils.js";

export type AttestedTransactionOptions = {
	epoch: bigint;
	seed: string;
	participants: string[];
};

export const attestedTransaction = ({
	epoch,
	seed,
	participants,
}: AttestedTransactionOptions): ConsensusChainEvent[] => [
	{
		name: "TransactionProposed",
		epoch,
		transaction: transaction(seed),
	},
	{
		name: "Sign",
		sid: signatureId(seed, 1n),
		message: transactionProposalMessage({
			epoch,
			safeTxHash: safeTxHash(transaction(seed)),
		}),
	},
	...participants.map((participant) => ({
		name: "SignShared" as const,
		sid: signatureId(seed, 1n),
		selectionRoot: selectionRoot(`${seed}:1`),
		participant: namedAddress(participant),
	})),
	{
		name: "SignCompleted",
		sid: signatureId(seed, 1n),
		selectionRoot: selectionRoot(`${seed}:1`),
	},
	{
		name: "TransactionAttested",
		sid: signatureId(seed, 1n),
	},
];

export type SentinelRequestOptions = {
	seed: string;
	reveals: string[];
};

/**
 * A sentinel oracle request answered by a set of sentinels in the same block.
 *
 * Reveals landing in a later block - possibly even in a later period - are not
 * covered by this preset, as they need to be placed in their own slot.
 */
export const sentinelRequest = ({
	seed,
	reveals,
}: SentinelRequestOptions): ConsensusChainEvent[] => [
	{
		name: "NewRequest",
		requestId: requestId(seed),
	},
	...reveals.map((sentinel) => ({
		name: "Revealed" as const,
		requestId: requestId(seed),
		sentinel: namedAddress(sentinel),
		approved: true,
	})),
];
