import {
	type Address,
	encodeFunctionData,
	encodePacked,
	getAddress,
	type Hex,
	hashTypedData,
	keccak256,
	parseAbi,
	parseUnits,
	slice,
	toHex,
	zeroAddress,
} from "viem";

export const namedAddress = (name: string): Address =>
	getAddress(slice(keccak256(toHex(`address:${name}`)), 12));

const deriveId = (seed: string): Hex => keccak256(toHex(`group:${seed}`));
const maskId = (unmasked: Hex, tail: bigint): Hex =>
	encodePacked(["bytes24", "uint64"], [slice(unmasked, 0, 24), tail]);

export const groupId = (seed: string): Hex => maskId(deriveId(seed), 0n);

export const signatureId = (groupSeed: string, sequence: bigint): Hex =>
	maskId(deriveId(groupSeed), sequence);

export const extractSignatureId = (sid: Hex): { gid: Hex; sequence: bigint } => ({
	gid: maskId(sid, 0n),
	sequence: BigInt(slice(sid, 24)),
});

export type Point = {
	x: bigint;
	y: bigint;
};

export type Signature = {
	r: Point;
	z: bigint;
};

export const signature = (seed: string): Signature => ({
	r: {
		x: BigInt(keccak256(toHex(`signature:r:x:${seed}`))),
		y: BigInt(keccak256(toHex(`signature:r:y:${seed}`))),
	},
	z: BigInt(keccak256(toHex(`signature:z:${seed}`))),
});

export const selectionRoot = (seed: string): Hex => keccak256(toHex(`selectionroot:${seed}`));

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

export const transaction = (
	seed: string,
	opts: { isValid: boolean } = { isValid: true },
): SafeTransaction => ({
	chainId: 0x5afen,
	safe: namedAddress("safe"),
	to: namedAddress("to"),
	value: 0n,
	data: encodeFunctionData({
		abi: parseAbi(["function transaction(string seed)"]),
		functionName: "transaction",
		args: [seed],
	}),
	operation: opts.isValid ? 0 : 1,
	safeTxGas: 0n,
	baseGas: 0n,
	gasPrice: 0n,
	gasToken: zeroAddress,
	refundReceiver: zeroAddress,
	nonce: 0n,
});

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

export type TransactionProposal = {
	epoch: bigint;
	safeTxHash: Hex;
};

export const transactionProposalMessage = (message: TransactionProposal): Hex =>
	hashTypedData({
		domain: {
			chainId: 100,
			verifyingContract: namedAddress("Consensus"),
		},
		types: {
			TransactionProposal: [
				{ type: "uint64", name: "epoch" },
				{ type: "bytes32", name: "safeTxHash" },
			],
		},
		primaryType: "TransactionProposal",
		message,
	});

export type EmptyBlockSpec = {
	assertTimestamp: bigint;
};

export const emptyBlocks = (
	count: number,
	assertion?: Required<EmptyBlockSpec>,
): EmptyBlockSpec[] => {
	const blocks = [...Array(count)].map(() => ({}) as EmptyBlockSpec);
	if (assertion !== undefined) {
		const last = blocks.at(-1);
		if (last === undefined) {
			throw new Error("at least one empty block needed for a timestamp assertion");
		}
		last.assertTimestamp = assertion.assertTimestamp;
	}
	return blocks;
};

export const parseSafe = (amount: string): bigint => parseUnits(amount, 18);
