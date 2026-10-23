import {
	type Address,
	encodeAbiParameters,
	encodeEventTopics,
	encodePacked,
	type Hex,
	keccak256,
	parseAbiParameters,
	toHex,
	zeroAddress,
	zeroHash,
} from "viem";
import {
	CONSENSUS_ABI,
	COORDINATOR_ABI,
	DELEGATE_REGISTRY_ABI,
	SANCTIONS_LIST_ABI,
	SENTINEL_ORACLE_ABI,
	STAKING_ABI,
} from "../../src/abi.js";
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
	  }
	| {
			name: "SanctionedAddressesAdded";
			addresses: Address[];
	  }
	| {
			name: "SanctionedAddressesRemoved";
			addresses: Address[];
	  }
	| {
			name: "SetDelegate";
			delegator: Address;
			delegate: Address;
	  }
	| {
			name: "ClearDelegate";
			delegator: Address;
			delegate: Address;
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
			sid: Hex;
	  }
	| {
			name: "KeyGenConfirmed";
			participant: Address;
	  }
	| {
			name: "Sign";
			sid: Hex;
			message: Hex;
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
	  }
	| {
			name: "NewRequest";
			requestId: Hex;
	  }
	| {
			name: "Revealed";
			requestId: Hex;
			sentinel: Address;
			approved: boolean;
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
	/**
	 * Block the sentinel oracle indexer starts at, defaulting to the first
	 * block of the consensus chain. Requests created before it are not indexed,
	 * which is the only way for a `Revealed` to reference an unknown request.
	 */
	sentinelOracleStartBlock?: bigint;
	/**
	 * The timestamp both chains start at, `0` by default. Scenarios that need real dates, such as
	 * a period on top of a rewards DB that ends with Beta, start the chains just before them.
	 */
	genesisTimestamp?: bigint;
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
		case "SanctionedAddressesAdded":
		case "SanctionedAddressesRemoved": {
			return {
				address: namedAddress("SanctionsList"),
				topics: encodeEventTopics({
					abi: SANCTIONS_LIST_ABI,
					eventName: event.name,
				}) as Hex[],
				data: encodeAbiParameters(parseAbiParameters("address[] addrs"), [event.addresses]),
			};
		}
		case "SetDelegate":
		case "ClearDelegate": {
			return {
				address: namedAddress("DelegateRegistry"),
				topics: encodeEventTopics({
					abi: DELEGATE_REGISTRY_ABI,
					eventName: event.name,
					args: {
						delegator: event.delegator,
						id: keccak256(toHex("Safenet Beta validator commission beneficiary")),
						delegate: event.delegate,
					},
				}) as Hex[],
				data: "0x",
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
						safeId: encodePacked(
							["uint96", "address"],
							[event.transaction.chainId, event.transaction.safe],
						),
						oracle: namedAddress("SentinelOracle"),
					},
				}) as Hex[],
				data: encodeAbiParameters(
					parseAbiParameters(
						"uint64 epoch, bytes oracleData, (uint256 chainId, address safe, address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) transaction",
					),
					[event.epoch, "0x", event.transaction],
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
						safeTxHash: zeroHash,
						safeId: zeroHash,
						oracle: zeroAddress,
					},
				}) as Hex[],
				data: encodeAbiParameters(
					parseAbiParameters(
						"uint64 epoch, bytes32 oracleDataHash, bytes32 signatureId, ((uint256 x, uint256 y) r, uint256 z) attestation",
					),
					[0n, zeroHash, event.sid, { r: { x: 0n, y: 0n }, z: 0n }],
				),
			};
		}
		case "KeyGenConfirmed": {
			return {
				address: namedAddress("FROSTCoordinator"),
				topics: encodeEventTopics({
					abi: COORDINATOR_ABI,
					eventName: "KeyGenConfirmed",
					args: {
						gid: zeroHash,
					},
				}) as Hex[],
				data: encodeAbiParameters(parseAbiParameters("address participant, bool confirmed"), [
					event.participant,
					false,
				]),
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
		case "NewRequest": {
			return {
				address: namedAddress("SentinelOracle"),
				topics: encodeEventTopics({
					abi: SENTINEL_ORACLE_ABI,
					eventName: "NewRequest",
					args: {
						requestId: event.requestId,
						sponsor: zeroAddress,
					},
				}) as Hex[],
				data: encodeAbiParameters(
					parseAbiParameters(
						"uint96 fee, uint96 bondTarget, uint24 daoFeeShare, uint96 slashAmount, uint64 commitDeadline, uint64 revealDeadline",
					),
					[0n, 0n, 0, 0n, 0n, 0n],
				),
			};
		}
		case "Revealed": {
			return {
				address: namedAddress("SentinelOracle"),
				topics: encodeEventTopics({
					abi: SENTINEL_ORACLE_ABI,
					eventName: "Revealed",
					args: {
						requestId: event.requestId,
						sentinel: event.sentinel,
					},
				}) as Hex[],
				data: encodeAbiParameters(
					parseAbiParameters("bool approved, uint96 bondAmount, string reason"),
					[event.approved, 0n, ""],
				),
			};
		}
	}
};

const encodeChain = <E>(
	{ chainId, blockTime, genesisTimestamp }: Omit<ChainSpec, "slots">,
	spec: TypedChainSpec<E>,
	encodeEvent: (event: E) => LogSpec,
): MockChain =>
	new MockChain({
		chainId,
		blockTime,
		genesisTimestamp,
		...spec,
		slots: spec.slots.map((slot) =>
			slot !== null ? { logs: slot.events?.map(encodeEvent) } : null,
		),
	});

/**
 * The `Safenet.create` parameters for a scenario, with mock clients for both chains, so that a
 * test can wrap a client or pass the same configuration to code other than `Safenet`.
 */
export const createTestParameters = (scenario: Scenario) => {
	const stakingChain = encodeChain(
		{ chainId: 1, blockTime: 12n, genesisTimestamp: scenario.genesisTimestamp },
		scenario.staking,
		encodeStakingEvent,
	);
	const consensusChain = encodeChain(
		{ chainId: 100, blockTime: 5n, genesisTimestamp: scenario.genesisTimestamp },
		scenario.consensus,
		encodeConsensusEvent,
	);

	return {
		databaseFile: ":memory:",
		stakingClient: createMockClient(stakingChain),
		stakingBlockPageSize: 5n,
		stakingAddress: namedAddress("Staking"),
		delegateRegistryAddress: namedAddress("DelegateRegistry"),
		sanctionsListAddress: namedAddress("SanctionsList"),
		sanctionsAddressRepo: "example/sanctions-address-lists",
		consensusClient: createMockClient(consensusChain),
		consensusBlockPageSize: 5n,
		consensusAddress: namedAddress("Consensus"),
		sentinelOracleAddress: namedAddress("SentinelOracle"),
		sentinelOracleStartBlock: scenario.sentinelOracleStartBlock,
	} satisfies Parameters<typeof Safenet.create>[0];
};

export const createTestSafenet = (scenario: Scenario): Promise<Safenet> =>
	Safenet.create(createTestParameters(scenario));
