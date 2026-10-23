/**
 * The action bundles of a distribution: Safe Transaction Builder bundles that any Safe can load to
 * propose the distribution and answer its Reality.eth question **Yes**.
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

// Bundles are created at the settlement, in milliseconds since the Unix epoch, so that they don't
// depend on when they were built.
const createdAt = (settlementTimestamp: bigint): number => Number(settlementTimestamp) * 1000;

/**
 * `propose.json`: `RealityModule.addProposal(proposalId, [transaction.hash])`, which asks the
 * proposal's Reality.eth question with nonce `0`. It needs no bond.
 */
export const proposeBundle = (
	proposal: Proposal,
	config: Pick<GovernanceConfiguration, "module">,
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
		],
		createdAt(settlementTimestamp),
	);

/**
 * `answer.json`: `bondToken.approve(oracle, minimumBond)`, then
 * `oracle.submitAnswerERC20(questionId, bytes32(1), 0, minimumBond)`, the first **Yes** answer
 * with the module's minimum bond.
 *
 * A `max_previous` of `0` disables Reality.eth's previous-bond check. The answer still reverts
 * once anyone has answered, because every later answer must at least double the current bond,
 * which is at least the minimum bond.
 */
export const answerBundle = (
	proposal: Pick<Proposal, "questionId">,
	config: Pick<GovernanceConfiguration, "bondToken" | "minimumBond" | "oracle">,
	settlementTimestamp: bigint,
): TransactionBundle =>
	transactionBundle(
		[
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
