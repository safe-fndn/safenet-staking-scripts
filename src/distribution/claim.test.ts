import { type Address, decodeFunctionData, type Hex, zeroHash } from "viem";
import { describe, expect, it } from "vitest";
import { REALITY_ETH_ERC20_ABI } from "../abi.js";
import { type Answer, claimArguments, claimBundle, type QuestionClaim } from "./claim.js";

// The answers to the period 2 question on mainnet, oldest first. Its winnings were claimed in
// 0x2340cc0ce358ad3553e2917613de5181adb7b0b5652562f64e679aa73108d503 with the same arguments.
const ORACLE: Address = "0xdd34D37ABD603658b039BB46f25769E21e252A43";
const QUESTION_ID: Hex = "0x5dfb13c6d3361dad3b5ebc83e452d8f57a403ab4bcef38e3ad86ed66e45d87b1";
const PROPOSER: Address = "0x22835ECa2d767C4D214472483484efd095b8889d";
const CHALLENGER: Address = "0x46c403e3DcAF219D9D4De167cCc4e0dd8E81Eb72";
const YES: Hex = `0x${"0".repeat(63)}1`;
const NO: Hex = zeroHash;
const SAFE = 10n ** 18n;
const H1: Hex = "0x0ae9aa764abe6d768ea15e41633ce0b1e9f5e0ad0a187a51a9a7eb35b744fda8";
const H2: Hex = "0x253bebd84ce7fda704437b8384d5a00bd7fdb861f5352bde4d4855dbc345366e";
const H3: Hex = "0xf1ef00c32eb0fe993b18edffd40d375b493b25d974a499fc9967881655d8fc48";
const FINALIZE_TIMESTAMP = 1794572867n;

const ANSWERS: Answer[] = [
	{ answer: YES, historyHash: H1, user: PROPOSER, bond: 10000n * SAFE, isCommitment: false },
	{ answer: NO, historyHash: H2, user: CHALLENGER, bond: 20000n * SAFE, isCommitment: false },
	{ answer: YES, historyHash: H3, user: CHALLENGER, bond: 40000n * SAFE, isCommitment: false },
];

const claim = (overrides: Partial<QuestionClaim> = {}): QuestionClaim => ({
	blockNumber: 26406474n,
	questionId: QUESTION_ID,
	finalized: true,
	finalizeTimestamp: FINALIZE_TIMESTAMP,
	historyHash: H3,
	answers: ANSWERS,
	balances: { [PROPOSER]: 0n, [CHALLENGER]: 0n },
	...overrides,
});

const decode = (data: Hex | null) =>
	decodeFunctionData({ abi: REALITY_ETH_ERC20_ABI, data: data as Hex });

describe("claimArguments", () => {
	it("walks the full history from the newest answer back", () => {
		expect(claimArguments(claim())).toEqual({
			historyHashes: [H2, H1, zeroHash],
			addrs: [CHALLENGER, CHALLENGER, PROPOSER],
			bonds: [40000n * SAFE, 20000n * SAFE, 10000n * SAFE],
			answers: [YES, NO, YES],
		});
	});

	it("claims only the answers up to the stored history hash after a partial claim", () => {
		expect(claimArguments(claim({ historyHash: H2 }))).toEqual({
			historyHashes: [H1, zeroHash],
			addrs: [CHALLENGER, PROPOSER],
			bonds: [20000n * SAFE, 10000n * SAFE],
			answers: [NO, YES],
		});
	});

	it("refuses a question that is already claimed", () => {
		expect(() => claimArguments(claim({ historyHash: zeroHash }))).toThrow("is already claimed");
	});

	it("refuses a question that is not finalized", () => {
		expect(() => claimArguments(claim({ finalized: false }))).toThrow("is not finalized");
	});

	it("refuses commitments, which need a reveal first", () => {
		const answers = ANSWERS.map((answer, i) =>
			i === 1 ? { ...answer, isCommitment: true } : answer,
		);
		expect(() => claimArguments(claim({ answers }))).toThrow(`has a commitment by ${CHALLENGER}`);
	});

	it("refuses a history that does not hash to the logged history hashes", () => {
		const answers = ANSWERS.map((answer, i) => (i === 0 ? { ...answer, bond: SAFE } : answer));
		expect(() => claimArguments(claim({ answers }))).toThrow("does not hash to");
	});

	it("refuses a history that does not reach the stored history hash", () => {
		expect(() => claimArguments(claim({ answers: ANSWERS.slice(0, 2) }))).toThrow(
			`does not reach history hash ${H3}`,
		);
	});
});

describe("claimBundle", () => {
	it("claims the winnings, created at the finalization", () => {
		const bundle = claimBundle(ORACLE, claim());
		expect(bundle).toEqual({
			version: "1.0",
			chainId: "1",
			createdAt: Number(FINALIZE_TIMESTAMP) * 1000,
			meta: {},
			transactions: [
				{
					to: ORACLE,
					value: "0",
					data: expect.any(String),
					contractMethod: null,
					contractInputsValues: null,
				},
			],
		});
		const [claimWinnings] = bundle.transactions;
		expect(decode(claimWinnings.data)).toEqual({
			functionName: "claimWinnings",
			args: [
				QUESTION_ID,
				[H2, H1, zeroHash],
				[CHALLENGER, CHALLENGER, PROPOSER],
				[40000n * SAFE, 20000n * SAFE, 10000n * SAFE],
				[YES, NO, YES],
			],
		});
	});
});
