import {
	type Address,
	encodeAbiParameters,
	encodeEventTopics,
	type Hex,
	parseAbiParameters,
	zeroAddress,
	zeroHash,
} from "viem";
import { CONSENSUS_ABI, COORDINATOR_ABI, STAKING_ABI } from "../../src/abi.js";
import { Safenet } from "../../src/safenet.js";
import {
	type BlockSpec,
	type ChainSpec,
	createMockClient,
	type LogSpec,
	MockChain,
} from "./chain.js";
import { extractSignatureId, namedAddress, type SafeTransaction, safeTxHash } from "./utils.js";

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
			epoch: bigint;
			transaction: SafeTransaction;
			sid: Hex;
	  }
	| {
			name: "KeyGen";
			gid: Hex;
			count: number;
			threshold: number;
	  }
	| {
			name: "Sign";
			sid: Hex;
			message: Hex;
	  }
	| {
			name: "SignRevealedNonces";
			sid: Hex;
			participant: Address;
	  }
	| {
			name: "SignShared";
			sid: Hex;
			selectionRoot: Hex;
			participant: Address;
	  }
	| {
			name: "SignCompleted";
			sid: Hex;
			selectionRoot: Hex;
	  };

export type TypedBlockSpec<E> = Omit<BlockSpec, "logs"> & {
	events?: E[];
};

export type TypedChainSpec<E> = {
	blockTime?: bigint;
	slots: (TypedBlockSpec<E> | null)[];
};

export type Scenario = {
	staking: TypedChainSpec<StakingChainEvent>;
	consensus: TypedChainSpec<ConsensusChainEvent>;
};

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
						safeTxHash: safeTxHash(event.transaction),
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
					args: {
						safeTxHash: safeTxHash(event.transaction),
						chainId: event.transaction.chainId,
						safe: event.transaction.safe,
					},
				}) as Hex[],
				data: encodeAbiParameters(
					parseAbiParameters(
						"uint64 epoch, bytes32 signatureId, ((uint256 x, uint256 y) r, uint256 z) attestation",
					),
					[event.epoch, event.sid, { r: { x: 0n, y: 0n }, z: 0n }],
				),
			};
		}
		case "KeyGen": {
			return {
				address: namedAddress("FROSTCoordinator"),
				topics: encodeEventTopics({
					abi: COORDINATOR_ABI,
					eventName: "KeyGen",
					args: {
						gid: event.gid,
						context: zeroHash,
					},
				}) as Hex[],
				data: encodeAbiParameters(
					parseAbiParameters("bytes32 participants, uint16 count, uint16 threshold"),
					[zeroHash, event.count, event.threshold],
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
						"address participant, ((uint256 x, uint256 y) d, (uint256 x, uint256 y) e) nonces",
					),
					[event.participant, { d: { x: 0n, y: 0n }, e: { x: 0n, y: 0n } }],
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
				data: encodeAbiParameters(parseAbiParameters("address participant, uint256 z"), [
					event.participant,
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
					[{ r: { x: 0n, y: 0n }, z: 0n }],
				),
			};
		}
	}
};

const encodeChain = <E>(
	{ chainId, blockTime }: Pick<ChainSpec, "chainId" | "blockTime">,
	spec: TypedChainSpec<E>,
	encodeEvent: (event: E) => LogSpec,
): MockChain =>
	new MockChain({
		chainId,
		blockTime,
		...spec,
		slots: spec.slots.map((slot) =>
			slot !== null ? { logs: slot.events?.map(encodeEvent) } : null,
		),
	});

export const createTestSafenet = (scenario: Scenario): Promise<Safenet> => {
	const stakingChain = encodeChain(
		{ chainId: 1, blockTime: 12n },
		scenario.staking,
		encodeStakingEvent,
	);
	const consensusChain = encodeChain(
		{ chainId: 100, blockTime: 5n },
		scenario.consensus,
		encodeConsensusEvent,
	);

	return Safenet.create({
		databaseFile: ":memory:",
		blockPageSize: 5n,
		stakingClient: createMockClient(stakingChain),
		stakingAddress: namedAddress("Staking"),
		consensusClient: createMockClient(consensusChain),
		consensusAddress: namedAddress("Consensus"),
	});
};
