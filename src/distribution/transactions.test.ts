import { base32upper } from "multiformats/bases/base32";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import {
	concat,
	decodeFunctionData,
	getAddress,
	type Hex,
	hexToBigInt,
	namehash,
	size,
	slice,
	stringToHex,
	toHex,
} from "viem";
import { describe, expect, it } from "vitest";
import {
	AMOUNT,
	BATCH_DATA,
	CONFIG,
	CUMULATIVE_MERKLE_DROP,
	ENS_NAME,
	ENS_NODE,
	MERKLE_ROOT,
	MODULE,
	OTHER_QUESTION_ID,
	OTHER_TX_HASH,
	PINNED_CID,
	PINNED_CONTENTHASH,
	QUESTION,
	QUESTION_ID,
	RESOLVER,
	SAFE_TOKEN,
	SET_CONTENTHASH_DATA,
	SET_MERKLE_ROOT_DATA,
	TRANSFER_DATA,
	TX_HASH,
	UPDATE,
} from "../../tests/harness/governance.js";
import { CUMULATIVE_MERKLE_DROP_ABI, ENS_RESOLVER_ABI, ERC20_ABI, MULTI_SEND_ABI } from "../abi.js";
import { jsonReplacer } from "../utils/json.js";
import {
	buildQuestion,
	decodeContenthash,
	encodeContenthash,
	type GovernanceCall,
	governanceCalls,
	governanceTransaction,
	MULTI_SEND_CALL_ONLY,
	multiSend,
	proposal,
	questionId,
	transactionHash,
	zProposal,
} from "./transactions.js";

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
