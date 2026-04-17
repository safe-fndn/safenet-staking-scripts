import type { ConsensusChainEvent } from "./scenario.js";
import {
	namedAddress,
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
