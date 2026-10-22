import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import {
	type Address,
	concat,
	decodeFunctionData,
	getAddress,
	type Hex,
	hexToBigInt,
	namehash,
	parseUnits,
	size,
	slice,
	stringToHex,
	toHex,
} from "viem";
import { describe, expect, it } from "vitest";
import { CUMULATIVE_MERKLE_DROP_ABI, ENS_RESOLVER_ABI, ERC20_ABI, MULTI_SEND_ABI } from "../abi.js";
import {
	type DistributionUpdate,
	decodeContenthash,
	encodeContenthash,
	type GovernanceCall,
	governanceCalls,
	governanceTransaction,
	MULTI_SEND_CALL_ONLY,
	multiSend,
} from "./transactions.js";

// Every vector below was read from Ethereum mainnet at block 26247049 with read-only `eth_call`s
// against the deployed governance contracts:
//
// - the resolver and `contenthash` of `rewards.safenet-gov.eth` from the ENS registry's
//   `resolver(namehash(name))` and the resolver's `contenthash(namehash(name))`;
// - the Merkle root from `CumulativeMerkleDrop.merkleRoot()`, and the SAFE token from
//   `Staking.SAFE_TOKEN()`.
//
// At block 26247609, the Governance Safe `0xAd21…ff59` reports `VERSION()` 1.4.1, has no
// transaction guard or module guard set, and `MULTI_SEND_CALL_ONLY` has the runtime code hash
// `0xecd5…9939` that `safe-deployments` lists for the canonical 1.4.1 `MultiSendCallOnly`.
// `execTransactionFromModule(MULTI_SEND_CALL_ONLY, 0, BATCH_DATA, 1)` called on the Safe from the
// Reality Module returns `true`.
//
// The transactions re-propose the current onchain state with a 172,603.12 SAFE transfer.

const PINNED_CID = "bafybeiczeo7uiupwte7dfa3yaus6dogwauxbookpvcgmxebbga5jtp7afq";
const PINNED_CONTENTHASH =
	"0xe301017012205923bf4451f6993e3283780525e1b8d6052e17394fa88ccb9021303a99bfe02c";

const SAFE_TOKEN: Address = "0x5aFE3855358E112B5647B952709E6165e1c1eEEe";
const CUMULATIVE_MERKLE_DROP: Address = "0xe5139Fc0FB8eae81e30d8a85C22E88c6757120f2";
const RESOLVER: Address = "0xF29100983E058B709F3D539b0c765937B804AC15";
const ENS_NAME = "rewards.safenet-gov.eth";
const ENS_NODE = "0x2ca43be3a22c27d01383e19bcae6429fce3b62edb69123ec3d512c9f5f448491";
const MERKLE_ROOT = "0x668901980a6c69b801f37cdef375059369dab712db8651a463d1d336b65cfdef";
const AMOUNT = parseUnits("172603.12", 18);

const CONFIG = {
	ensName: ENS_NAME,
	ensResolver: RESOLVER,
};

const UPDATE: DistributionUpdate = {
	additionalAmount: AMOUNT,
	cid: CID.parse(PINNED_CID),
	cumulativeMerkleDrop: CUMULATIVE_MERKLE_DROP,
	merkleRoot: MERKLE_ROOT,
	safeToken: SAFE_TOKEN,
};

const TRANSFER_DATA =
	"0xa9059cbb000000000000000000000000e5139fc0fb8eae81e30d8a85c22e88c6757120f200000000000000000000000000000000000000000000248cd5796d7a19180000";
const SET_MERKLE_ROOT_DATA =
	"0x7cb64759668901980a6c69b801f37cdef375059369dab712db8651a463d1d336b65cfdef";
const SET_CONTENTHASH_DATA =
	"0x304e6ade2ca43be3a22c27d01383e19bcae6429fce3b62edb69123ec3d512c9f5f44849100000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000026e301017012205923bf4451f6993e3283780525e1b8d6052e17394fa88ccb9021303a99bfe02c0000000000000000000000000000000000000000000000000000";

const BATCH_DATA =
	"0x8d80ff0a0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000020b005afe3855358e112b5647b952709e6165e1c1eeee00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000044a9059cbb000000000000000000000000e5139fc0fb8eae81e30d8a85c22e88c6757120f200000000000000000000000000000000000000000000248cd5796d7a1918000000e5139fc0fb8eae81e30d8a85c22e88c6757120f2000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000247cb64759668901980a6c69b801f37cdef375059369dab712db8651a463d1d336b65cfdef00f29100983e058b709f3d539b0c765937b804ac15000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a4304e6ade2ca43be3a22c27d01383e19bcae6429fce3b62edb69123ec3d512c9f5f44849100000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000026e301017012205923bf4451f6993e3283780525e1b8d6052e17394fa88ccb9021303a99bfe02c0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

// Decodes `multiSend` calldata back into its packed calls, independently of `multiSend`.
const decodeMultiSend = (data: Hex) => {
	const { functionName, args } = decodeFunctionData({ abi: MULTI_SEND_ABI, data });
	expect(functionName).toBe("multiSend");
	const [packed] = args;
	const calls = [];
	for (let offset = 0; offset < size(packed); ) {
		const length = Number(hexToBigInt(slice(packed, offset + 53, offset + 85)));
		calls.push({
			operation: Number(slice(packed, offset, offset + 1)),
			to: getAddress(slice(packed, offset + 1, offset + 21)),
			value: hexToBigInt(slice(packed, offset + 21, offset + 53)),
			data: length === 0 ? "0x" : slice(packed, offset + 85, offset + 85 + length),
		});
		offset += 85 + length;
	}
	return calls;
};

describe("governanceCalls", () => {
	it("builds transfer, setMerkleRoot and setContenthash in order", () => {
		const transactions = governanceCalls(UPDATE, CONFIG);
		expect(transactions).toEqual([
			{ to: SAFE_TOKEN, value: 0n, data: TRANSFER_DATA, operation: 0 },
			{ to: CUMULATIVE_MERKLE_DROP, value: 0n, data: SET_MERKLE_ROOT_DATA, operation: 0 },
			{ to: RESOLVER, value: 0n, data: SET_CONTENTHASH_DATA, operation: 0 },
		]);

		const [transfer, setMerkleRoot, setContenthash] = transactions;
		expect(transfer.data.slice(0, 10)).toBe("0xa9059cbb");
		expect(decodeFunctionData({ abi: ERC20_ABI, data: transfer.data })).toEqual({
			functionName: "transfer",
			args: [CUMULATIVE_MERKLE_DROP, AMOUNT],
		});
		expect(setMerkleRoot.data.slice(0, 10)).toBe("0x7cb64759");
		expect(
			decodeFunctionData({ abi: CUMULATIVE_MERKLE_DROP_ABI, data: setMerkleRoot.data }),
		).toEqual({ functionName: "setMerkleRoot", args: [MERKLE_ROOT] });
		expect(setContenthash.data.slice(0, 10)).toBe("0x304e6ade");
		expect(namehash(ENS_NAME)).toBe(ENS_NODE);
		expect(decodeFunctionData({ abi: ENS_RESOLVER_ABI, data: setContenthash.data })).toEqual({
			functionName: "setContenthash",
			args: [ENS_NODE, PINNED_CONTENTHASH],
		});
	});

	it("keeps the transfer when nothing is added", () => {
		const [transfer] = governanceCalls({ ...UPDATE, additionalAmount: 0n }, CONFIG);
		expect(decodeFunctionData({ abi: ERC20_ABI, data: transfer.data }).args).toEqual([
			CUMULATIVE_MERKLE_DROP,
			0n,
		]);
	});
});

describe("multiSend", () => {
	it("packs each call as operation, to, value, data length and data", () => {
		const calls: GovernanceCall[] = [
			{ to: "0x0000000000000000000000000000000000000001", value: 0n, data: "0x", operation: 0 },
			{
				to: "0x0000000000000000000000000000000000000002",
				value: 1n,
				data: "0xdeadbeef",
				operation: 0,
			},
		];
		// 2 calls of 85 + 0 and 85 + 4 bytes = 174 (0xae) bytes, padded to 192 bytes.
		const packed = [
			"00",
			"0000000000000000000000000000000000000001",
			"0000000000000000000000000000000000000000000000000000000000000000",
			"0000000000000000000000000000000000000000000000000000000000000000",
			"00",
			"0000000000000000000000000000000000000002",
			"0000000000000000000000000000000000000000000000000000000000000001",
			"0000000000000000000000000000000000000000000000000000000000000004",
			"deadbeef",
		].join("");
		expect(multiSend(calls)).toEqual({
			to: MULTI_SEND_CALL_ONLY,
			value: 0n,
			data: `0x8d80ff0a${[
				"0000000000000000000000000000000000000000000000000000000000000020",
				"00000000000000000000000000000000000000000000000000000000000000ae",
				packed,
				"0".repeat(36),
			].join("")}`,
			operation: 1,
		});
		expect(decodeMultiSend(multiSend(calls).data)).toEqual(calls);
	});
});

describe("governanceTransaction", () => {
	it("delegatecalls MultiSendCallOnly with the three calls in order", () => {
		const transaction = governanceTransaction(UPDATE, CONFIG);
		expect(transaction).toEqual({
			to: "0x9641d764fc13c8B624c04430C7356C1C7C8102e2",
			value: 0n,
			data: BATCH_DATA,
			operation: 1,
		});
		expect(decodeMultiSend(transaction.data)).toEqual(governanceCalls(UPDATE, CONFIG));
	});

	it("keeps the transfer when nothing is added", () => {
		const update = { ...UPDATE, additionalAmount: 0n };
		const calls = decodeMultiSend(governanceTransaction(update, CONFIG).data);
		expect(calls).toHaveLength(3);
		expect(calls[0].to).toBe(SAFE_TOKEN);
		expect(decodeFunctionData({ abi: ERC20_ABI, data: calls[0].data }).args).toEqual([
			CUMULATIVE_MERKLE_DROP,
			0n,
		]);
	});
});

describe("contenthash", () => {
	const cid = CID.parse(PINNED_CID);

	it("encodes the pinned CID as its onchain record", () => {
		expect(encodeContenthash(cid)).toBe(PINNED_CONTENTHASH);
	});

	it("decodes the onchain record to the pinned CID", () => {
		expect(decodeContenthash(PINNED_CONTENTHASH).toString()).toBe(PINNED_CID);
		expect(decodeContenthash(PINNED_CONTENTHASH.toUpperCase().replace("0X", "0x") as Hex)).toEqual(
			cid,
		);
	});

	it("round-trips", () => {
		expect(decodeContenthash(encodeContenthash(cid)).equals(cid)).toBe(true);
	});

	it("rejects other namespaces, CIDv0, other CIDs and garbage", () => {
		const cidBytes = toHex(cid.bytes);
		const v0 = cid.toV0();
		const rawCid = CID.createV1(raw.code, cid.multihash);
		const cases: [Hex, RegExp][] = [
			["0x", /not an IPFS contenthash/],
			["0xe3", /not an IPFS contenthash/],
			// ipns-ns and swarm-ns
			[concat(["0xe501", cidBytes]), /not an IPFS contenthash/],
			[concat(["0xe401", cidBytes]), /not an IPFS contenthash/],
			["0xe301", /invalid CID/],
			["0xe30101", /invalid CID/],
			[concat(["0xe301", cidBytes, "0x00"]), /invalid CID/],
			[concat(["0xe301", toHex(v0.bytes)]), /not a CIDv1 sha2-256 dag-pb CID/],
			[concat(["0xe301", toHex(rawCid.bytes)]), /not a CIDv1 sha2-256 dag-pb CID/],
			[stringToHex(PINNED_CID), /not an IPFS contenthash/],
		];
		for (const [contenthash, error] of cases) {
			expect(() => decodeContenthash(contenthash), contenthash).toThrow(error);
		}
	});

	it("refuses to encode anything but a package CID", () => {
		expect(() => encodeContenthash(cid.toV0())).toThrow(/not a CIDv1/);
		expect(() => encodeContenthash(CID.createV1(raw.code, cid.multihash))).toThrow(/not a CIDv1/);
	});
});
