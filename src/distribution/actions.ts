/**
 * The action bundles of a distribution: Safe Transaction Builder bundles that any Safe can load to
 * propose the distribution.
 *
 * Every bundle is a pure function of `proposal.json`, the governance configuration and the
 * settlement timestamp, so that the export and `cmd:verify` derive identical bundles. Bundles use
 * raw `data`, `chainId: "1"`, `createdAt = settlementTimestamp × 1000` and no
 * `createdFromSafeAddress`. The calls follow `RealityModule.sol` of
 * `gnosisguild/zodiac-module-reality`.
 */

import { encodeFunctionData } from "viem";
import { REALITY_MODULE_ABI } from "../abi.js";
import { type TransactionBundle, transactionBundle } from "../utils/bundle.js";
import type { GovernanceConfiguration, Proposal } from "./transactions.js";

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
