import { parseAbi } from "viem";

export const STAKING_ABI = parseAbi([
	"event StakeIncreased(address indexed staker, address indexed validator, uint256 amount)",
	"event WithdrawalInitiated(address indexed staker, address indexed validator, uint64 indexed withdrawalId, uint256 amount)",
	"event ValidatorUpdated(address indexed validator, bool isRegistered)",
]);

export const COORDINATOR_ABI = parseAbi([
	"event KeyGen(bytes32 indexed gid, bytes32 participants, uint16 count, uint16 threshold, bytes32 context)",
	"event KeyGenCommitted(bytes32 indexed gid, uint256 identifier, address participant, ((uint256 x, uint256 y) q, (uint256 x, uint256 y)[] c, (uint256 x, uint256 y) r, uint256 mu) commitment, bool committed)",
	"event Sign(address indexed initiator, bytes32 indexed gid, bytes32 indexed message, bytes32 sid, uint64 sequence)",
	"event SignRevealedNonces(bytes32 indexed sid, uint256 identifier, ((uint256 x, uint256 y) d, (uint256 x, uint256 y) e) nonces)",
	"event SignShared(bytes32 indexed sid, bytes32 indexed selectionRoot, uint256 identifier, uint256 z)",
	"event SignCompleted(bytes32 indexed sid, bytes32 indexed selectionRoot, ((uint256 x, uint256 y) r, uint256 z) signature)",
]);

export const CONSENSUS_ABI = parseAbi([
	"event ValidatorStakerSet(address indexed validator, address staker)",
	"event TransactionProposed(bytes32 indexed transactionHash, uint256 indexed chainId, address indexed safe, uint64 epoch, (uint256 chainId, address safe, address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) transaction)",
	"event TransactionAttested(bytes32 indexed transactionHash, uint64 epoch, ((uint256 x, uint256 y) r, uint256 z) attestation)",
	"function COORDINATOR() external view returns (address coordinator)",
]);
