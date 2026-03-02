import { parseAbi } from "viem";

export const STAKING_ABI = parseAbi([
	"event StakeIncreased(address indexed staker, address indexed validator, uint256 amount)",
	"event WithdrawalInitiated(address indexed staker, address indexed validator, uint64 indexed withdrawalId, uint256 amount)",
	"event ValidatorUpdated(address indexed validator, bool isRegistered)",
]);

export const COORDINATOR_ABI = parseAbi([
	"event SignShared(bytes32 indexed sid, bytes32 indexed selectionRoot, uint256 identifier, uint256 z)",
	"event SignCompleted(bytes32 indexed sid, bytes32 indexed selectionRoot, ((uint256 x, uint256 y) r, uint256 z) signature)",
]);

export const CONSENSUS_ABI = parseAbi([
	"event ValidatorStakerSet(address indexed validator, address staker)",
	"event TransactionAttested(bytes32 indexed transactionHash, uint64 epoch, ((uint256 x, uint256 y) r, uint256 z) attestation)",
	"function COORDINATOR() external view returns (address coordinator)",
]);
