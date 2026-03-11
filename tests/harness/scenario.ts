import {
	type Address,
	encodeAbiParameters,
	encodeEventTopics,
	type Hex,
	hashTypedData,
	parseAbiParameters,
	slice,
	zeroAddress,
	zeroHash,
} from "viem";
import { CONSENSUS_ABI, COORDINATOR_ABI, STAKING_ABI } from "../../src/abi.js";
import type { Safenet } from "../../src/safenet.js";
import { type BlockSpec, type ChainSpec, type LogSpec, MockChain } from "./chain.js";
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

export type TypedBlockSpec<E> = Omit<BlockSpec, "logs"> & {
	events?: E[];
};

export type TypedChainSpec<E> = Omit<ChainSpec, "slots"> & {
	slots: (TypedBlockSpec<E> | null)[];
};

export type Scenario = {
	staking: TypedChainSpec<StakingChainEvent>;
	consensus: TypedChainSpec<ConsensusChainEvent>;
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

const extractSignatureId = (sid: Hex): { gid: Hex; sequence: bigint } => ({
	gid: sid.replace(/[0-9a-fA-F]{16}$/, "0000000000000000") as Hex,
	sequence: BigInt(slice(sid, 24)),
});

const encodeStakingEvent = (event: StakingChainEvent): LogSpec => {
	switch (event.name) {
		case "ValidatorUpdated": {
			return {
				address: namedAddress("Staking"),
				topics: encodeEventTopics({
					abi: STAKING_ABI,
					eventName: "ValidatorUpdated",
					args: {
						validator: event.validator,
					},
				}) as Hex[],
				data: encodeAbiParameters(parseAbiParameters("bool isRegistered"), [event.isRegistered]),
			};
		}
		case "StakeIncreased": {
			return {
				address: namedAddress("Staking"),
				topics: encodeEventTopics({
					abi: STAKING_ABI,
					eventName: "StakeIncreased",
					args: {
						staker: event.staker,
						validator: event.validator,
					},
				}) as Hex[],
				data: encodeAbiParameters(parseAbiParameters("uint256 amount"), [event.amount]),
			};
		}
		case "WithdrawalInitiated": {
			return {
				address: namedAddress("Staking"),
				topics: encodeEventTopics({
					abi: STAKING_ABI,
					eventName: "WithdrawalInitiated",
					args: {
						staker: event.staker,
						validator: event.validator,
						withdrawalId: 1337n, // ignored
					},
				}) as Hex[],
				data: encodeAbiParameters(parseAbiParameters("uint256 amount"), [event.amount]),
			};
		}
	}
};

const encodeConsensusEvent = (event: ConsensusChainEvent): LogSpec => {
	switch (event.name) {
		case "ValidatorStakerSet": {
			return {
				address: namedAddress("Consensus"),
				topics: encodeEventTopics({
					abi: CONSENSUS_ABI,
					eventName: "ValidatorStakerSet",
					args: {
						validator: event.validator,
					},
				}) as Hex[],
				data: encodeAbiParameters(parseAbiParameters("address"), [event.staker]),
			};
		}
		case "TransactionProposed": {
			return {
				address: namedAddress("Consensus"),
				topics: encodeEventTopics({
					abi: CONSENSUS_ABI,
					eventName: "TransactionProposed",
					args: {
						transactionHash: safeTxHash(event.transaction),
						chainId: event.transaction.chainId,
						safe: event.transaction.safe,
					},
				}) as Hex[],
				data: encodeAbiParameters(
					parseAbiParameters(
						"uint64 epoch, (uint256 chainId, address safe, address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) transaction",
					),
					[event.epoch, event.transaction],
				),
			};
		}
		case "TransactionAttested": {
			return {
				address: namedAddress("Consensus"),
				topics: encodeEventTopics({
					abi: CONSENSUS_ABI,
					eventName: "TransactionAttested",
					args: { transactionHash: event.safeTxHash },
				}) as Hex[],
				data: encodeAbiParameters(
					parseAbiParameters("uint64 epoch, ((uint256 x, uint256 y) r, uint256 z) attestation"),
					[event.epoch, event.attestation],
				),
			};
		}
		case "KeyGen": {
			return {
				address: namedAddress("FROSTCoordinator"),
				topics: encodeEventTopics({
					abi: COORDINATOR_ABI,
					eventName: "KeyGen",
					args: { gid: event.gid },
				}) as Hex[],
				data: encodeAbiParameters(
					parseAbiParameters(
						"bytes32 participants, uint16 count, uint16 threshold, bytes32 context",
					),
					[zeroHash, event.count, event.threshold, zeroHash],
				),
			};
		}
		case "KeyGenCommitted": {
			return {
				address: namedAddress("FROSTCoordinator"),
				topics: encodeEventTopics({
					abi: COORDINATOR_ABI,
					eventName: "KeyGenCommitted",
					args: { gid: event.gid },
				}) as Hex[],
				data: encodeAbiParameters(
					parseAbiParameters(
						"uint256 identifier, address participant, ((uint256 x, uint256 y) q, (uint256 x, uint256 y)[] c, (uint256 x, uint256 y) r, uint256 mu) commitment, bool committed",
					),
					[
						event.identifier,
						event.participant,
						{ q: { x: 0n, y: 0n }, c: [], r: { x: 0n, y: 0n }, mu: 0n },
						false,
					],
				),
			};
		}
		case "Sign": {
			const { gid, sequence } = extractSignatureId(event.sid);
			return {
				address: namedAddress("FROSTCoordinator"),
				topics: encodeEventTopics({
					abi: COORDINATOR_ABI,
					eventName: "Sign",
					args: {
						initiator: zeroAddress,
						gid,
						message: event.message,
					},
				}) as Hex[],
				data: encodeAbiParameters(parseAbiParameters("bytes32 sid, uint64 sequence"), [
					event.sid,
					sequence,
				]),
			};
		}
		case "SignRevealedNonces": {
			return {
				address: namedAddress("FROSTCoordinator"),
				topics: encodeEventTopics({
					abi: COORDINATOR_ABI,
					eventName: "SignRevealedNonces",
					args: {
						sid: event.sid,
					},
				}) as Hex[],
				data: encodeAbiParameters(
					parseAbiParameters(
						"uint256 identifier, ((uint256 x, uint256 y) d, (uint256 x, uint256 y) e) nonces",
					),
					[event.identifier, { d: { x: 0n, y: 0n }, e: { x: 0n, y: 0n } }],
				),
			};
		}
		case "SignShared": {
			return {
				address: namedAddress("FROSTCoordinator"),
				topics: encodeEventTopics({
					abi: COORDINATOR_ABI,
					eventName: "SignShared",
					args: {
						sid: event.sid,
						selectionRoot: event.selectionRoot,
					},
				}) as Hex[],
				data: encodeAbiParameters(parseAbiParameters("uint256 identifier, uint256 z"), [
					event.identifier,
					0n,
				]),
			};
		}
		case "SignCompleted": {
			return {
				address: namedAddress("FROSTCoordinator"),
				topics: encodeEventTopics({
					abi: COORDINATOR_ABI,
					eventName: "SignCompleted",
					args: {
						sid: event.sid,
						selectionRoot: event.selectionRoot,
					},
				}) as Hex[],
				data: encodeAbiParameters(
					parseAbiParameters("((uint256 x, uint256 y) r, uint256 z) signature"),
					[event.signature],
				),
			};
		}
	}
};

const encodeChain = <E>(spec: TypedChainSpec<E>, encodeEvent: (event: E) => LogSpec): MockChain =>
	new MockChain({
		...spec,
		slots: spec.slots.map((slot) =>
			slot !== null
				? {
						...slot,
						logs: slot.events?.map(encodeEvent),
					}
				: null,
		),
	});

export const createTestSafenet = (scenario: Scenario): Promise<Safenet> => {
	const stakingChain = encodeChain(scenario.staking, encodeStakingEvent);
	const consensusChain = encodeChain(scenario.consensus, encodeConsensusEvent);
	console.log(stakingChain, consensusChain);

	return Promise.resolve({} as unknown as Safenet);
};
