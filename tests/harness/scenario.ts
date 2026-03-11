import {
	type Address,
	encodeAbiParameters,
	encodeEventTopics,
	encodePacked,
	type Hex,
	hashTypedData,
	keccak256,
	toHex,
} from "viem";
import { CONSENSUS_ABI, COORDINATOR_ABI, STAKING_ABI } from "../../src/abi.js";
import type { LogSpec } from "./chain.js";
import { namedAddress } from "./utils.js";

export type Point = {
	x: bigint;
	y: bigint;
};

export type Signature = {
	r: Point;
	z: bigint;
};

export type SafeTransaction = {
	chainId: bigint;
	safe: Address;
	to: Address;
	value: bigint;
	data: Hex;
	operation: 0 | 1;
	safeTxGas: bigint;
	baseGas: bigint;
	gasPrice: bigint;
	gasToken: Address;
	refundReceiver: Address;
	nonce: bigint;
};

export type StakingChainEvent =
	| {
			name: "ValidatorUpdated";
			validator: Address;
			isRegistered: boolean;
	  }
	| {
			name: "StakeIncreased";
			staker: Address;
			validator: Address;
			amount: bigint;
	  }
	| {
			name: "WithdrawalInitiated";
			staker: Address;
			validator: Address;
			amount: bigint;
	  };

export type ConsensusChainEvent =
	| {
			name: "ValidatorStakerSet";
			validator: Address;
			staker: Address;
	  }
	| {
			name: "TransactionProposed";
			epoch: bigint;
			transaction: SafeTransaction;
	  }
	| {
			name: "TransactionAttested";
			safeTxHash: Hex;
			epoch: bigint;
			attestation: Signature;
	  }
	| {
			name: "KeyGen";
			gid: Hex;
			count: number;
			threshold: number;
	  }
	| {
			name: "KeyGenCommitted";
			gid: Hex;
			identifier: bigint;
			participant: Address;
	  }
	| {
			name: "Sign";
			sid: Hex;
			message: Hex;
	  }
	| {
			name: "SignRevealedNonces";
			sid: Hex;
			identifier: bigint;
	  }
	| {
			name: "SignShared";
			sid: Hex;
			selectionRoot: Hex;
			identifier: bigint;
	  }
	| {
			name: "SignCompleted";
			sid: Hex;
			selectionRoot: Hex;
			signature: Signature;
	  };

export const safeTxHash = ({ chainId, safe, ...message }: SafeTransaction): Hex =>
	hashTypedData({
		domain: {
			chainId,
			verifyingContract: safe,
		},
		types: {
			SafeTx: [
				{ type: "address", name: "to" },
				{ type: "uint256", name: "value" },
				{ type: "bytes", name: "data" },
				{ type: "uint8", name: "operation" },
				{ type: "uint256", name: "safeTxGas" },
				{ type: "uint256", name: "baseGas" },
				{ type: "uint256", name: "gasPrice" },
				{ type: "address", name: "gasToken" },
				{ type: "address", name: "refundReceiver" },
				{ type: "uint256", name: "nonce" },
			],
		},
		primaryType: "SafeTx",
		message,
	});

const encodeStakingEvent = (event: StakingChainEvent): LogSpec => {
	switch (event.name) {
		case "ValidatorUpdated": {
			return {
				address: namedAddress("Staking contract"),
				topics: encodeEventTopics({
					abi: STAKING_ABI,
					eventName: "ValidatorUpdated",
					args: {
						validator: event.validator,
					},
				}) as Hex[],
				data: encodeAbiParameters([{ type: "bool" }], [event.isRegistered]),
			};
		}
		case "StakeIncreased": {
			return {
				address: namedAddress("Staking contract"),
				topics: encodeEventTopics({
					abi: STAKING_ABI,
					eventName: "StakeIncreased",
					args: {
						staker: event.staker,
						validator: event.validator,
					},
				}) as Hex[],
				data: encodeAbiParameters([{ type: "uint256" }], [event.amount]),
			};
		}
		case "WithdrawalInitiated": {
			return {
				address: namedAddress("Staking contract"),
				topics: encodeEventTopics({
					abi: STAKING_ABI,
					eventName: "WithdrawalInitiated",
					args: {
						staker: event.staker,
						validator: event.validator,
						withdrawalId: 1337n, // ignored
					},
				}) as Hex[],
				data: encodeAbiParameters([{ type: "uint256" }], [event.amount]),
			};
		}
	}
};

function encodeConsensusEvent(event: ConsensusChainEvent, defaultGid: Hex): LogSpec {
	switch (event.name) {
		case "ValidatorStakerSet": {
			const topics = encodeEventTopics({
				abi: CONSENSUS_ABI,
				eventName: "ValidatorStakerSet",
				args: { validator: event.validator },
			}) as Hex[];
			const data = encodeAbiParameters([{ type: "address" }] as const, [event.staker]);
			return makeRawLog(CONSENSUS_ADDRESS, topics, data, ctx);
		}
		case "TransactionProposed": {
			const txHash = safeTxHash(event.transaction);
			const topics = encodeEventTopics({
				abi: CONSENSUS_ABI,
				eventName: "TransactionProposed",
				args: {
					transactionHash: txHash,
					chainId: event.transaction.chainId,
					safe: event.transaction.safe,
				},
			}) as Hex[];
			const data = encodeAbiParameters(
				[{ type: "uint64", name: "epoch" }, ...SAFE_TX_TUPLE] as const,
				[event.epoch, event.transaction],
			);
			return makeRawLog(CONSENSUS_ADDRESS, topics, data, ctx);
		}
		case "TransactionAttested": {
			const topics = encodeEventTopics({
				abi: CONSENSUS_ABI,
				eventName: "TransactionAttested",
				args: { transactionHash: event.transactionHash },
			}) as Hex[];
			const data = encodeAbiParameters(
				[{ type: "uint64", name: "epoch" }, SIGNATURE_ABI] as const,
				[event.epoch, event.attestation],
			);
			return makeRawLog(CONSENSUS_ADDRESS, topics, data, ctx);
		}
		case "KeyGen": {
			const topics = encodeEventTopics({
				abi: COORDINATOR_ABI,
				eventName: "KeyGen",
				args: { gid: event.gid },
			}) as Hex[];
			const data = encodeAbiParameters(
				[
					{ type: "bytes32", name: "participants" },
					{ type: "uint16", name: "count" },
					{ type: "uint16", name: "threshold" },
					{ type: "bytes32", name: "context" },
				] as const,
				[zeroHash, event.count, event.threshold, event.context ?? zeroHash],
			);
			return makeRawLog(COORDINATOR_ADDRESS, topics, data, ctx);
		}
		case "KeyGenCommitted": {
			const commitment: KeyGenCommitment = event.commitment ?? {
				q: { x: 0n, y: 0n },
				c: [],
				r: { x: 0n, y: 0n },
				mu: 0n,
			};
			const topics = encodeEventTopics({
				abi: COORDINATOR_ABI,
				eventName: "KeyGenCommitted",
				args: { gid: event.gid },
			}) as Hex[];
			const data = encodeAbiParameters(
				[
					{ type: "uint256", name: "identifier" },
					{ type: "address", name: "participant" },
					COMMITMENT_ABI,
					{ type: "bool", name: "committed" },
				] as const,
				[event.identifier, event.participant, commitment, event.committed ?? true],
			);
			return makeRawLog(COORDINATOR_ADDRESS, topics, data, ctx);
		}
		case "Sign": {
			const gid = event.gid ?? defaultGid;
			const topics = encodeEventTopics({
				abi: COORDINATOR_ABI,
				eventName: "Sign",
				args: {
					initiator: event.initiator ?? zeroAddress,
					gid,
					message: event.message,
				},
			}) as Hex[];
			const data = encodeAbiParameters(
				[
					{ type: "bytes32", name: "sid" },
					{ type: "uint64", name: "sequence" },
				] as const,
				[event.sid, event.sequence ?? 0n],
			);
			return makeRawLog(COORDINATOR_ADDRESS, topics, data, ctx);
		}
		case "SignRevealedNonces": {
			const nonces: Nonces = event.nonces ?? {
				d: { x: 0n, y: 0n },
				e: { x: 0n, y: 0n },
			};
			const topics = encodeEventTopics({
				abi: COORDINATOR_ABI,
				eventName: "SignRevealedNonces",
				args: { sid: event.sid },
			}) as Hex[];
			const data = encodeAbiParameters(
				[{ type: "uint256", name: "identifier" }, NONCES_ABI] as const,
				[event.identifier, nonces],
			);
			return makeRawLog(COORDINATOR_ADDRESS, topics, data, ctx);
		}
		case "SignShared": {
			const topics = encodeEventTopics({
				abi: COORDINATOR_ABI,
				eventName: "SignShared",
				args: { sid: event.sid, selectionRoot: event.selectionRoot },
			}) as Hex[];
			const data = encodeAbiParameters(
				[
					{ type: "uint256", name: "identifier" },
					{ type: "uint256", name: "z" },
				] as const,
				[event.identifier, event.z ?? 0n],
			);
			return makeRawLog(COORDINATOR_ADDRESS, topics, data, ctx);
		}
		case "SignCompleted": {
			const topics = encodeEventTopics({
				abi: COORDINATOR_ABI,
				eventName: "SignCompleted",
				args: { sid: event.sid, selectionRoot: event.selectionRoot },
			}) as Hex[];
			const data = encodeAbiParameters([SIGNATURE_ABI] as const, [event.signature]);
			return makeRawLog(COORDINATOR_ADDRESS, topics, data, ctx);
		}
	}
}
