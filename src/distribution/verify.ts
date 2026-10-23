/** Re-derives the next distribution and classifies its onchain proposals. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import debug from "debug";
import type { Safenet } from "../safenet.js";
import { type Backoff, backoff } from "../utils/backoff.js";
import { blockAtTimestamp } from "../utils/blocks.js";
import { type Export, type ExportConfiguration, exportPackage } from "./export.js";
import { findProposal, type OnchainProposal } from "./onchain.js";

export type Verification = {
	/** All export data remains usable in memory; the temporary package directory is removed. */
	distribution: Omit<Export, "dir">;
	onchain: OnchainProposal;
	/** Any different question takes precedence, including alongside matching questions. */
	outcome: "none yet" | "matching" | "different";
};

/**
 * Uses the export pipeline without overrides, on top of the latest ENS-pinned rewards DB.
 * Searches inclusively from the last Ethereum block at or before the consensus settlement
 * timestamp. No proposal yet is a successful verification; different questions are returned
 * alongside any matches so callers can report every question that needs attention.
 *
 * The package directory is always removed, including on export or lookup failure. The returned
 * distribution retains the CID, CAR, proposal and reward summary, but no path into that tree.
 */
export const verifyProposal = async (
	safenet: Safenet,
	config: ExportConfiguration,
	options: { withBackoff?: Backoff } = {},
): Promise<Verification> => {
	const withBackoff = options.withBackoff ?? backoff({ debug: debug("safenet:verify") });
	const temporary = await mkdtemp(join(tmpdir(), "safenet-verify-"));
	try {
		const { dir: _dir, ...distribution } = await exportPackage(
			safenet,
			config,
			join(temporary, "package"),
		);
		const timestamp = distribution.settlement.settlementTimestamp;
		const from = await blockAtTimestamp(config.stakingClient, { timestamp }, withBackoff);
		if (from === null) {
			throw new Error(`settlement timestamp ${timestamp} is before the Ethereum genesis block`);
		}
		const { module, oracle } = distribution.governance;
		const onchain = await findProposal(
			config.stakingClient,
			{ module, oracle, fromBlock: from.number },
			distribution.proposal,
			{ withBackoff },
		);
		const outcome =
			onchain.different.length > 0
				? "different"
				: onchain.matching.length > 0
					? "matching"
					: "none yet";
		return { distribution, onchain, outcome };
	} finally {
		await rm(temporary, { force: true, recursive: true });
	}
};
