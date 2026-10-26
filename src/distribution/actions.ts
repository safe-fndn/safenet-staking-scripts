/**
 * The action bundles of a distribution: Safe Transaction Builder bundles that any Safe can load to
 * propose the distribution, answer its Reality.eth question **Yes**, and execute it.
 *
 * Every bundle is a pure function of `proposal.json`, the governance configuration and the
 * settlement timestamp, so that the export and `cmd:verify` derive identical bundles. Bundles use
 * raw `data`, `chainId: "1"`, `createdAt = settlementTimestamp × 1000` and no
 * `createdFromSafeAddress`. The calls follow `RealityModule.sol` of
 * `gnosisguild/zodiac-module-reality` and `RealityETH_ERC20-3.0.sol` of `RealityETH`.
 */

import { encodeFunctionData, type Hex, numberToHex } from "viem";
import { ERC20_ABI, REALITY_ETH_ERC20_ABI, REALITY_MODULE_ABI } from "../abi.js";
import { type TransactionBundle, transactionBundle } from "../utils/bundle.js";
import type { GovernanceConfiguration, Proposal } from "./transactions.js";

/**
 * The Reality.eth answer **Yes** to the module's boolean question template, `bytes32(1)`.
 */
export const ANSWER_YES: Hex = numberToHex(1, { size: 32 });

/**
 * The action bundles of a distribution, keyed by the name of their release asset without `.json`.
 */
export type ActionBundles = {
	execute: TransactionBundle;
	propose: TransactionBundle;
};

// Bundles are created at the settlement, in milliseconds since the Unix epoch, so that they don't
// depend on when they were built.
const createdAt = (settlementTimestamp: bigint): number => Number(settlementTimestamp) * 1000;

/**
 * `propose.json`: asks the proposal's nonce-0 Reality.eth question with `addProposal`, approves
 * the minimum bond to the oracle, then submits the first Yes answer with that bond.
 * The proposing Safe needs the bond token, and the proposal must not already exist.
 *
 * A `max_previous` of `0` disables Reality.eth's previous-bond check. Later answers require
 * at least double the current bond and must be submitted manually.
 */
export const proposeBundle = (
	proposal: Proposal,
	config: Pick<GovernanceConfiguration, "bondToken" | "minimumBond" | "module" | "oracle">,
	settlementTimestamp: bigint,
): TransactionBundle =>
	transactionBundle(
		[
			{
				to: config.module,
				data: encodeFunctionData({
					abi: REALITY_MODULE_ABI,
					functionName: "addProposal",
					args: [proposal.proposalId, [proposal.transaction.hash]],
				}),
			},
			{
				to: config.bondToken,
				data: encodeFunctionData({
					abi: ERC20_ABI,
					functionName: "approve",
					args: [config.oracle, config.minimumBond],
				}),
			},
			{
				to: config.oracle,
				data: encodeFunctionData({
					abi: REALITY_ETH_ERC20_ABI,
					functionName: "submitAnswerERC20",
					args: [proposal.questionId, ANSWER_YES, 0n, config.minimumBond],
				}),
			},
		],
		createdAt(settlementTimestamp),
	);

/**
 * `execute.json`: `RealityModule.executeProposalWithIndex(proposalId, [transaction.hash], to,
 * value, data, operation, 0)`, which executes the proposal's only transaction once its answer is
 * final, the cooldown has elapsed and the answer has not expired.
 */
export const executeBundle = (
	proposal: Proposal,
	config: Pick<GovernanceConfiguration, "module">,
	settlementTimestamp: bigint,
): TransactionBundle => {
	const { data, hash, operation, to, value } = proposal.transaction;
	return transactionBundle(
		[
			{
				to: config.module,
				data: encodeFunctionData({
					abi: REALITY_MODULE_ABI,
					functionName: "executeProposalWithIndex",
					args: [proposal.proposalId, [hash], to, value, data, operation, 0n],
				}),
			},
		],
		createdAt(settlementTimestamp),
	);
};

/**
 * Both action bundles of a distribution.
 */
export const actionBundles = (
	proposal: Proposal,
	config: Pick<GovernanceConfiguration, "bondToken" | "minimumBond" | "module" | "oracle">,
	settlementTimestamp: bigint,
): ActionBundles => ({
	execute: executeBundle(proposal, config, settlementTimestamp),
	propose: proposeBundle(proposal, config, settlementTimestamp),
});
