import { decodeFunctionData, type Hex, slice } from "viem";
import { describe, expect, it } from "vitest";
import { CONFIG, MODULE, PINNED_CID, TX_HASH, UPDATE } from "../../tests/harness/governance.js";
import { REALITY_MODULE_ABI } from "../abi.js";
import { proposeBundle } from "./actions.js";
import { proposal } from "./transactions.js";

// The proposal re-proposes the pinned CID and root with the mainnet vectors of
// `tests/harness/governance.ts`. Its settlement is an arbitrary timestamp.
const PROPOSAL = proposal(UPDATE, CONFIG);
const SETTLEMENT_TIMESTAMP = 1793405040n;
const CREATED_AT = 1793405040000;

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
