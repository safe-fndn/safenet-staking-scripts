import { decodeFunctionData, type Hex, slice } from "viem";
import { describe, expect, it } from "vitest";
import {
	BATCH_DATA,
	CONFIG,
	MODULE,
	PINNED_CID,
	QUESTION_ID,
	SAFE_TOKEN,
	TX_HASH,
	UPDATE,
} from "../../tests/harness/governance.js";
import { ERC20_ABI, REALITY_ETH_ERC20_ABI, REALITY_MODULE_ABI } from "../abi.js";
import { jsonReplacer } from "../utils/json.js";
import {
	ANSWER_YES,
	actionBundles,
	answerBundle,
	executeBundle,
	proposeBundle,
} from "./actions.js";
import { MULTI_SEND_CALL_ONLY, proposal } from "./transactions.js";

// The proposal re-proposes the pinned CID and root with the mainnet vectors of
// `tests/harness/governance.ts`. Its settlement is an arbitrary timestamp.
const PROPOSAL = proposal(UPDATE, CONFIG);
const SETTLEMENT_TIMESTAMP = 1793405040n;
const CREATED_AT = 1793405040000;

const ORACLE = "0xdd34D37ABD603658b039BB46f25769E21e252A43";
const MINIMUM_BOND = 10000n * 10n ** 18n;

const selector = (data: Hex | null) => (data === null ? null : slice(data, 0, 4));

describe("proposeBundle", () => {
	it("adds the proposal with its single transaction hash", () => {
		expect(PROPOSAL.proposalId).toBe(PINNED_CID);
		expect(PROPOSAL.transaction.hash).toBe(TX_HASH);

		const bundle = proposeBundle(PROPOSAL, CONFIG, SETTLEMENT_TIMESTAMP);
		expect(bundle).toEqual({
			version: "1.0",
			chainId: "1",
			createdAt: CREATED_AT,
			meta: {},
			transactions: [
				{
					to: MODULE,
					value: "0",
					data: expect.any(String),
					contractMethod: null,
					contractInputsValues: null,
				},
			],
		});
		expect(bundle).not.toHaveProperty("createdFromSafeAddress");

		const [{ data }] = bundle.transactions;
		expect(selector(data)).toBe("0x8dcd2661");
		expect(decodeFunctionData({ abi: REALITY_MODULE_ABI, data: data as Hex })).toEqual({
			functionName: "addProposal",
			args: [PINNED_CID, [TX_HASH]],
		});
	});
});

describe("answerBundle", () => {
	it("approves the minimum bond, then answers Yes with it", () => {
		expect(CONFIG.bondToken).toBe(SAFE_TOKEN);
		expect(CONFIG.oracle).toBe(ORACLE);
		expect(CONFIG.minimumBond).toBe(MINIMUM_BOND);
		expect(PROPOSAL.questionId).toBe(QUESTION_ID);

		const bundle = answerBundle(PROPOSAL, CONFIG, SETTLEMENT_TIMESTAMP);
		expect(bundle).toEqual({
			version: "1.0",
			chainId: "1",
			createdAt: CREATED_AT,
			meta: {},
			transactions: [
				{
					to: SAFE_TOKEN,
					value: "0",
					data: expect.any(String),
					contractMethod: null,
					contractInputsValues: null,
				},
				{
					to: ORACLE,
					value: "0",
					data: expect.any(String),
					contractMethod: null,
					contractInputsValues: null,
				},
			],
		});
		expect(bundle).not.toHaveProperty("createdFromSafeAddress");

		const [approve, submitAnswer] = bundle.transactions;
		expect(selector(approve.data)).toBe("0x095ea7b3");
		expect(decodeFunctionData({ abi: ERC20_ABI, data: approve.data as Hex })).toEqual({
			functionName: "approve",
			args: [ORACLE, MINIMUM_BOND],
		});
		expect(selector(submitAnswer.data)).toBe("0x2f998a6f");
		expect(
			decodeFunctionData({ abi: REALITY_ETH_ERC20_ABI, data: submitAnswer.data as Hex }),
		).toEqual({
			functionName: "submitAnswerERC20",
			args: [QUESTION_ID, ANSWER_YES, 0n, MINIMUM_BOND],
		});
		expect(ANSWER_YES).toBe(`0x${"0".repeat(63)}1`);
	});
});

describe("executeBundle", () => {
	it("executes the proposal's only transaction with index 0", () => {
		const bundle = executeBundle(PROPOSAL, CONFIG, SETTLEMENT_TIMESTAMP);
		expect(bundle).toEqual({
			version: "1.0",
			chainId: "1",
			createdAt: CREATED_AT,
			meta: {},
			transactions: [
				{
					to: MODULE,
					value: "0",
					data: expect.any(String),
					contractMethod: null,
					contractInputsValues: null,
				},
			],
		});
		expect(bundle).not.toHaveProperty("createdFromSafeAddress");

		const [{ data }] = bundle.transactions;
		expect(selector(data)).toBe("0x14604b8c");
		expect(decodeFunctionData({ abi: REALITY_MODULE_ABI, data: data as Hex })).toEqual({
			functionName: "executeProposalWithIndex",
			args: [PINNED_CID, [TX_HASH], MULTI_SEND_CALL_ONLY, 0n, BATCH_DATA, 1, 0n],
		});
	});

	it("commits to the proposal's transaction", () => {
		const [{ data }] = executeBundle(PROPOSAL, CONFIG, SETTLEMENT_TIMESTAMP).transactions;
		const { args } = decodeFunctionData({ abi: REALITY_MODULE_ABI, data: data as Hex });
		const { hash, to, value, data: transactionData, operation } = PROPOSAL.transaction;
		expect(args).toEqual([PINNED_CID, [hash], to, value, transactionData, operation, 0n]);
	});
});

describe("actionBundles", () => {
	const json = (value: unknown) => JSON.stringify(value, jsonReplacer, "\t");

	it("builds the three bundles", () => {
		expect(actionBundles(PROPOSAL, CONFIG, SETTLEMENT_TIMESTAMP)).toEqual({
			answer: answerBundle(PROPOSAL, CONFIG, SETTLEMENT_TIMESTAMP),
			execute: executeBundle(PROPOSAL, CONFIG, SETTLEMENT_TIMESTAMP),
			propose: proposeBundle(PROPOSAL, CONFIG, SETTLEMENT_TIMESTAMP),
		});
	});

	it("is deterministic", () => {
		const encoded = json(actionBundles(PROPOSAL, CONFIG, SETTLEMENT_TIMESTAMP));
		expect(json(actionBundles(proposal(UPDATE, CONFIG), CONFIG, SETTLEMENT_TIMESTAMP))).toBe(
			encoded,
		);
	});

	it("is created at the settlement", () => {
		const bundles = actionBundles(PROPOSAL, CONFIG, 1n);
		for (const bundle of Object.values(bundles)) {
			expect(bundle.createdAt).toBe(1000);
		}
	});
});
