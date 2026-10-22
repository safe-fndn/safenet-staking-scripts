/**
 * The Governance Safe transaction of a distribution.
 *
 * Everything here is a pure function of the distribution (the package CID, its Merkle root and the
 * funding amount) and of the ENS name and resolver, so that the export and `cmd:verify` derive
 * identical transactions. The distribution's calls are batched into a single `MultiSendCallOnly`
 * delegatecall. The package CID is pinned onchain as the ENSIP-7 `contenthash` of the
 * rewards ENS name. The Zodiac transaction hash follows `RealityModule.sol` of
 * `gnosisguild/zodiac-module-reality` exactly, and the tests check it against the deployed module.
 */

import { CID } from "multiformats/cid";
import {
	type Address,
	concat,
	encodeFunctionData,
	encodePacked,
	type Hex,
	hashTypedData,
	hexToBytes,
	namehash,
	size,
	toHex,
} from "viem";
import { CUMULATIVE_MERKLE_DROP_ABI, ENS_RESOLVER_ABI, ERC20_ABI, MULTI_SEND_ABI } from "../abi.js";

/**
 * The chain the Governance Safe and its Reality Module live on, Ethereum mainnet. It is the
 * `chainId` of the module's EIP-712 domain.
 */
export const GOVERNANCE_CHAIN_ID = 1;

/**
 * The canonical `MultiSendCallOnly` of Safe 1.4.1 (`safe-deployments`), the version of the
 * Governance Safe. The Governance Safe delegatecalls it to execute a distribution's calls in one
 * Zodiac transaction.
 */
export const MULTI_SEND_CALL_ONLY: Address = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2";

/**
 * What a distribution changes onchain, in the terms of the manifest's `distribution` block and
 * the package CID.
 */
export type DistributionUpdate = {
	/** The SAFE that the Cumulative Merkle Drop needs on top of what it already received. */
	additionalAmount: bigint;
	/** The package CID, which becomes the ENS `contenthash`. */
	cid: CID;
	cumulativeMerkleDrop: Address;
	merkleRoot: Hex;
	safeToken: Address;
};

/**
 * A transaction the Governance Safe executes through the module: a call (`0`) or a delegatecall
 * (`1`).
 */
export type GovernanceTransaction = {
	to: Address;
	value: bigint;
	data: Hex;
	operation: 0 | 1;
};

/**
 * A call batched into a `MultiSendCallOnly` transaction, which only allows calls.
 */
export type GovernanceCall = GovernanceTransaction & { operation: 0 };

export type ProposalTransaction = GovernanceTransaction & {
	/**
	 * The Zodiac transaction hash, whose nonce is the transaction's index in the proposal. A
	 * distribution's proposal has one transaction, so its nonce is 0.
	 */
	hash: Hex;
};

const DAG_PB = 0x70;
const SHA2_256 = 0x12;
const IPFS_NS = "0xe301";

const assertPackageCid = (cid: CID): void => {
	if (cid.version !== 1 || cid.code !== DAG_PB || cid.multihash.code !== SHA2_256) {
		throw new Error(`CID ${cid} is not a CIDv1 sha2-256 dag-pb CID`);
	}
};

/**
 * Encodes a package CID as an ENSIP-7 `contenthash`: the `ipfs-ns` multicodec (`0xe3 0x01`)
 * followed by the binary CIDv1.
 */
export const encodeContenthash = (cid: CID): Hex => {
	assertPackageCid(cid);
	return concat([IPFS_NS, toHex(cid.bytes)]);
};

/**
 * Decodes an ENSIP-7 `contenthash` that pins a package. It throws for anything other than an
 * `ipfs-ns` CIDv1 sha2-256 dag-pb directory CID with no trailing bytes, including an empty
 * (unset) record and a CIDv0.
 */
export const decodeContenthash = (contenthash: Hex): CID => {
	const bytes = hexToBytes(contenthash);
	if (bytes.length < 2 || bytes[0] !== 0xe3 || bytes[1] !== 0x01) {
		throw new Error(`contenthash ${contenthash} is not an IPFS contenthash`);
	}
	let cid: CID;
	try {
		cid = CID.decode(bytes.subarray(2));
	} catch (err) {
		const message = err instanceof Error ? err.message : "unknown error";
		throw new Error(`contenthash ${contenthash} has an invalid CID: ${message}`);
	}
	assertPackageCid(cid);
	return cid;
};

/**
 * The three Governance Safe calls of a distribution, in execution order:
 *
 * 1. `SAFE.transfer(cumulativeMerkleDrop, additionalAmount)`, so that the drop always holds enough
 *    tokens for its root;
 * 2. `CumulativeMerkleDrop.setMerkleRoot(merkleRoot)`;
 * 3. `resolver.setContenthash(namehash(ensName), 0xe301 ‖ CID)`.
 *
 * The transfer is included even when `additionalAmount` is 0, so a proposal always has the same
 * three calls.
 */
export const governanceCalls = (
	update: DistributionUpdate,
	config: { ensName: string; ensResolver: Address },
): [GovernanceCall, GovernanceCall, GovernanceCall] => [
	{
		to: update.safeToken,
		value: 0n,
		data: encodeFunctionData({
			abi: ERC20_ABI,
			functionName: "transfer",
			args: [update.cumulativeMerkleDrop, update.additionalAmount],
		}),
		operation: 0,
	},
	{
		to: update.cumulativeMerkleDrop,
		value: 0n,
		data: encodeFunctionData({
			abi: CUMULATIVE_MERKLE_DROP_ABI,
			functionName: "setMerkleRoot",
			args: [update.merkleRoot],
		}),
		operation: 0,
	},
	{
		to: config.ensResolver,
		value: 0n,
		data: encodeFunctionData({
			abi: ENS_RESOLVER_ABI,
			functionName: "setContenthash",
			args: [namehash(config.ensName), encodeContenthash(update.cid)],
		}),
		operation: 0,
	},
];

/**
 * Batches calls into one `MultiSendCallOnly.multiSend` delegatecall. Each call is packed as
 * `uint8 operation ‖ address to ‖ uint256 value ‖ uint256 dataLength ‖ bytes data`.
 */
export const multiSend = (calls: readonly GovernanceCall[]): GovernanceTransaction => ({
	to: MULTI_SEND_CALL_ONLY,
	value: 0n,
	data: encodeFunctionData({
		abi: MULTI_SEND_ABI,
		functionName: "multiSend",
		args: [
			concat(
				calls.map(({ operation, to, value, data }) =>
					encodePacked(
						["uint8", "address", "uint256", "uint256", "bytes"],
						[operation, to, value, BigInt(size(data)), data],
					),
				),
			),
		],
	}),
	operation: 1,
});

/**
 * The single Governance Safe transaction of a distribution: its three calls batched into one
 * `MultiSendCallOnly` delegatecall, so that they execute atomically.
 */
export const governanceTransaction = (
	update: DistributionUpdate,
	config: { ensName: string; ensResolver: Address },
): GovernanceTransaction => multiSend(governanceCalls(update, config));

/**
 * The Zodiac transaction hash, `RealityModule.getTransactionHash(to, value, data, operation,
 * nonce)`: the EIP-712 hash of `Transaction(address to,uint256 value,bytes data,uint8
 * operation,uint256 nonce)` in the domain `EIP712Domain(uint256 chainId,address
 * verifyingContract)` of the module on Ethereum mainnet. The nonce is the transaction's index in
 * the proposal.
 */
export const transactionHash = (
	module: Address,
	transaction: { to: Address; value: bigint; data: Hex; operation: number },
	nonce: bigint,
): Hex =>
	hashTypedData({
		domain: { chainId: GOVERNANCE_CHAIN_ID, verifyingContract: module },
		types: {
			Transaction: [
				{ name: "to", type: "address" },
				{ name: "value", type: "uint256" },
				{ name: "data", type: "bytes" },
				{ name: "operation", type: "uint8" },
				{ name: "nonce", type: "uint256" },
			],
		},
		primaryType: "Transaction",
		message: { ...transaction, nonce },
	});
