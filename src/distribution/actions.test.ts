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
import { canonicalJson } from "../utils/json.js";
import { ANSWER_YES, actionBundles, executeBundle, proposeBundle } from "./actions.js";
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
	it("proposes, approves the minimum bond, then answers Yes in one bundle", () => {
		expect(PROPOSAL.proposalId).toBe(PINNED_CID);
		expect(PROPOSAL.transaction.hash).toBe(TX_HASH);
		expect(PROPOSAL.questionId).toBe(QUESTION_ID);
		const bundle = proposeBundle(PROPOSAL, CONFIG, SETTLEMENT_TIMESTAMP);
		expect(bundle).toEqual({
			version: "1.0",
			chainId: "1",
			createdAt: CREATED_AT,
			meta: {},
			transactions: [MODULE, SAFE_TOKEN, ORACLE].map((to) => ({
				to,
				value: "0",
				data: expect.any(String),
				contractMethod: null,
				contractInputsValues: null,
			})),
		});
		const [propose, approve, submitAnswer] = bundle.transactions;
		expect(decodeFunctionData({ abi: REALITY_MODULE_ABI, data: propose.data as Hex })).toEqual({
			functionName: "addProposal",
			args: [PINNED_CID, [TX_HASH]],
		});
		expect(decodeFunctionData({ abi: ERC20_ABI, data: approve.data as Hex })).toEqual({
			functionName: "approve",
			args: [ORACLE, MINIMUM_BOND],
		});
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
	it("builds the two bundles", () => {
		expect(actionBundles(PROPOSAL, CONFIG, SETTLEMENT_TIMESTAMP)).toEqual({
			execute: executeBundle(PROPOSAL, CONFIG, SETTLEMENT_TIMESTAMP),
			propose: proposeBundle(PROPOSAL, CONFIG, SETTLEMENT_TIMESTAMP),
		});
	});

	it("is deterministic", () => {
		const encoded = canonicalJson(actionBundles(PROPOSAL, CONFIG, SETTLEMENT_TIMESTAMP));
		expect(
			canonicalJson(actionBundles(proposal(UPDATE, CONFIG), CONFIG, SETTLEMENT_TIMESTAMP)),
		).toBe(encoded);
	});

	it("is created at the settlement", () => {
		const bundles = actionBundles(PROPOSAL, CONFIG, 1n);
		for (const bundle of Object.values(bundles)) {
			expect(bundle.createdAt).toBe(1000);
		}
	});
});
