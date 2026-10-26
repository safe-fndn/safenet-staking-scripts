import { base32upper } from "multiformats/bases/base32";
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
	zeroAddress,
} from "viem";
import { describe, expect, it } from "vitest";
import { CUMULATIVE_MERKLE_DROP_ABI, ENS_RESOLVER_ABI, ERC20_ABI, MULTI_SEND_ABI } from "../abi.js";
import { jsonReplacer } from "../utils/json.js";
import {
	buildQuestion,
	type DistributionUpdate,
	decodeContenthash,
	encodeContenthash,
	type GovernanceCall,
	type GovernanceConfiguration,
	governanceCalls,
	governanceTransaction,
	MULTI_SEND_CALL_ONLY,
	multiSend,
	proposal,
	questionId,
	transactionHash,
	zProposal,
} from "./transactions.js";

// Every vector below was read from Ethereum mainnet at block 26247049 with read-only `eth_call`s
// against the deployed governance contracts:
//
// - the resolver and `contenthash` of `rewards.safenet-gov.eth` from the ENS registry's
//   `resolver(namehash(name))` and the resolver's `contenthash(namehash(name))`;
// - the Merkle root from `CumulativeMerkleDrop.merkleRoot()`, and the SAFE token from
//   `Staking.SAFE_TOKEN()`;
// - the configuration from the Reality Module `0x8DFc…83dC` getters (`avatar()`, `oracle()`,
//   `template()`, `questionArbitrator()`, `questionTimeout()`, `questionCooldown()`,
//   `answerExpiration()`, `minimumBond()`), and the bond token from `oracle.token()`;
// - `OTHER_TX_HASH` and `OTHER_QUESTION_ID` from the module's
//   `getTransactionHash(0x…01, 1, 0x, 1, 7)` and `getQuestionId("hello", 1)`, which cover a value,
//   a delegatecall and nonzero nonces.
//
// At block 26247609, the Governance Safe `0xAd21…ff59` reports `VERSION()` 1.4.1, has no
// transaction guard or module guard set, and `MULTI_SEND_CALL_ONLY` has the runtime code hash
// `0xecd5…9939` that `safe-deployments` lists for the canonical 1.4.1 `MultiSendCallOnly`.
// `execTransactionFromModule(MULTI_SEND_CALL_ONLY, 0, BATCH_DATA, 1)` called on the Safe from the
// Reality Module returns `true`, and the module's
// `getTransactionHash(MULTI_SEND_CALL_ONLY, 0, BATCH_DATA, 1, 0)` is `TX_HASH`. Its
// `buildQuestion(PINNED_CID, [TX_HASH])` is `QUESTION`, and `getQuestionId(QUESTION, 0)` is
// `QUESTION_ID`.
//
// The transactions re-propose the current onchain state with a 172,603.12 SAFE transfer.

const PINNED_CID = "bafybeiczeo7uiupwte7dfa3yaus6dogwauxbookpvcgmxebbga5jtp7afq";
const PINNED_CONTENTHASH =
	"0xe301017012205923bf4451f6993e3283780525e1b8d6052e17394fa88ccb9021303a99bfe02c";

const MODULE: Address = "0x8DFc5Db2C83200Cf0cC84d7e3C441d7721ef83dC";
const SAFE_TOKEN: Address = "0x5aFE3855358E112B5647B952709E6165e1c1eEEe";
const CUMULATIVE_MERKLE_DROP: Address = "0xe5139Fc0FB8eae81e30d8a85C22E88c6757120f2";
const RESOLVER: Address = "0xF29100983E058B709F3D539b0c765937B804AC15";
const ENS_NAME = "rewards.safenet-gov.eth";
const ENS_NODE = "0x2ca43be3a22c27d01383e19bcae6429fce3b62edb69123ec3d512c9f5f448491";
const MERKLE_ROOT = "0x668901980a6c69b801f37cdef375059369dab712db8651a463d1d336b65cfdef";
const AMOUNT = parseUnits("172603.12", 18);

const CONFIG: GovernanceConfiguration = {
	answerExpiration: 604800,
	arbitrator: zeroAddress,
	avatar: "0xAd219b3c26fe42BF5FC66F67490745a4fa5dff59",
	bondToken: SAFE_TOKEN,
	ensName: ENS_NAME,
	ensResolver: RESOLVER,
	minimumBond: parseUnits("10000", 18),
	module: MODULE,
	oracle: "0xdd34D37ABD603658b039BB46f25769E21e252A43",
	questionCooldown: 432000,
	questionTimeout: 259200,
	templateId: 6n,
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

const TX_HASH = "0xa7686cf4c2267bbbf49e0c39d9b8e9fc3de1d0113130bd2b8fa79a781353de42";
const OTHER_TX_HASH = "0x3e089cd52dda6a23342304de204d11b1bfe0c824496da98f45ef8f3eec1f92bc";
const QUESTION =
	"bafybeiczeo7uiupwte7dfa3yaus6dogwauxbookpvcgmxebbga5jtp7afq\u241fb79314c90e4cc2d42c3ca9e49a65c68f72e94497bf005d2ec04a560b3f8872d1";
const QUESTION_ID = "0xe19707dd522e3a2f4fb6919e90ea3d336aece7c078708a48420aa79d6724362e";
const OTHER_QUESTION_ID = "0x9fbd8246375e2333be381fdadd92bd2078e777a60ba574b464936ad88fe0e0ab";

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

describe("transactionHash", () => {
	it("matches the module's getTransactionHash", () => {
		expect(transactionHash(MODULE, governanceTransaction(UPDATE, CONFIG), 0n)).toBe(TX_HASH);
		expect(
			transactionHash(
				MODULE,
				{ to: "0x0000000000000000000000000000000000000001", value: 1n, data: "0x", operation: 1 },
				7n,
			),
		).toBe(OTHER_TX_HASH);
	});
});

describe("question", () => {
	it("builds the question byte for byte like buildQuestion", () => {
		const question = buildQuestion(PINNED_CID, [TX_HASH]);
		expect(question).toBe(QUESTION);
		expect(stringToHex(question)).toBe(
			concat([
				stringToHex(PINNED_CID),
				"0xe2909f",
				stringToHex("b79314c90e4cc2d42c3ca9e49a65c68f72e94497bf005d2ec04a560b3f8872d1"),
			]),
		);
	});

	it("matches the module's getQuestionId", () => {
		expect(questionId(QUESTION, CONFIG)).toBe(QUESTION_ID);
		expect(questionId("hello", CONFIG, 1n)).toBe(OTHER_QUESTION_ID);
	});
});

describe("proposal", () => {
	const expected = {
		calls: [
			{ data: TRANSFER_DATA, operation: 0, to: SAFE_TOKEN, value: 0n },
			{ data: SET_MERKLE_ROOT_DATA, operation: 0, to: CUMULATIVE_MERKLE_DROP, value: 0n },
			{ data: SET_CONTENTHASH_DATA, operation: 0, to: RESOLVER, value: 0n },
		],
		proposalId: PINNED_CID,
		questionId: QUESTION_ID,
		transaction: {
			data: BATCH_DATA,
			hash: TX_HASH,
			operation: 1,
			to: MULTI_SEND_CALL_ONLY,
			value: 0n,
		},
	};
	const json = (value: unknown) => JSON.stringify(value, jsonReplacer, "\t");

	it("derives the proposal ID, question ID, transaction and calls", () => {
		const derived = proposal(UPDATE, CONFIG);
		expect(derived).toEqual(expected);
		expect(derived.transaction.data).toBe(multiSend(derived.calls).data);
	});

	it("round-trips through its schema and is deterministic", () => {
		const encoded = json(proposal(UPDATE, CONFIG));
		expect(json(proposal(UPDATE, CONFIG))).toBe(encoded);
		const decoded = zProposal.parse(JSON.parse(encoded));
		expect(decoded).toEqual(expected);
		expect(json(decoded)).toBe(encoded);
	});

	it("rejects malformed proposals", () => {
		const valid = JSON.parse(json(proposal(UPDATE, CONFIG)));
		const [call, ...otherCalls] = valid.calls;
		const withCall = (changes: object) => ({
			...valid,
			calls: [{ ...call, ...changes }, ...otherCalls],
		});
		const withTransaction = (changes: object) => ({
			...valid,
			transaction: { ...valid.transaction, ...changes },
		});
		const invalid = [
			{ ...valid, proposalId: CID.parse(PINNED_CID).toV0().toString() },
			{ ...valid, proposalId: CID.parse(PINNED_CID).toString(base32upper) },
			{ ...valid, questionId: QUESTION_ID.toUpperCase() },
			{ ...valid, extra: true },
			{ ...valid, transaction: undefined },
			{ ...valid, calls: valid.calls.slice(0, 2) },
			{ ...valid, calls: [...valid.calls, call] },
			withTransaction({ to: SAFE_TOKEN }),
			withTransaction({ to: MULTI_SEND_CALL_ONLY.toLowerCase() }),
			withTransaction({ operation: 0 }),
			withTransaction({ hash: TX_HASH.toUpperCase() }),
			withTransaction({ extra: true }),
			withCall({ to: call.to.toLowerCase() }),
			withCall({ operation: 1 }),
			withCall({ value: "01" }),
			withCall({ value: 0 }),
			withCall({ data: "0xA9" }),
			withCall({ hash: TX_HASH }),
		];
		for (const value of invalid) {
			expect(zProposal.safeParse(value).success, JSON.stringify(value)).toBe(false);
		}
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
