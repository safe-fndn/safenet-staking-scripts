/** Plan the next distribution without indexing or computing rewards. */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress } from "viem";
import { getBlock, getChainId } from "viem/actions";
import { z } from "zod";
import { AEGIS } from "../config/aegis.js";
import { resolvePreviousRewardsDb } from "../distribution/previous.js";
import { GOVERNANCE_CHAIN_ID } from "../distribution/transactions.js";
import { nextRewardsStart } from "../merkledb/index.js";
import { SETTLEMENT_BLOCKS } from "../safenet.js";
import { main, rewardsPeriod } from "../utils/args.js";
import { backoff } from "../utils/backoff.js";
import { blockAtTimestamp, TimestampAfterLatestBlockError } from "../utils/blocks.js";
import { canonicalJson } from "../utils/json.js";

main(
	{
		previousCar: z.string().min(1).optional(),
		ipfsGatewayUrl: z.url().optional(),
		cumulativeMerkleDropAddress: z
			.string()
			.transform((v) => getAddress(v))
			.default(AEGIS.ethereum.cumulativeMerkleDrop),
		rewardsEnsName: z.string().min(1).default(AEGIS.ethereum.rewardsEnsName),
	},
	async (args) => {
		const withBackoff = backoff();
		const chainId = await withBackoff(() => getChainId(args.stakingClient));
		if (chainId !== GOVERNANCE_CHAIN_ID) {
			throw new Error(`staking chain ${chainId} is not the governance chain`);
		}
		const temporary = await mkdtemp(join(tmpdir(), "safenet-plan-"));
		let output: string;
		try {
			const previous = await resolvePreviousRewardsDb(
				args.stakingClient,
				{ ensName: args.rewardsEnsName, cumulativeMerkleDrop: args.cumulativeMerkleDropAddress },
				args,
				join(temporary, "previous"),
				{ withBackoff },
			);
			const period = rewardsPeriod({ rewardPeriodStart: nextRewardsStart(previous.rewardsUntil) });
			let settled = false;
			try {
				const boundary = await blockAtTimestamp(
					args.consensusClient,
					{ timestamp: period.toTimestamp, fromBlock: args.consensusStartBlock },
					withBackoff,
				);
				if (boundary === null) {
					throw new Error(`period end ${period.toTimestamp} is before the consensus start block`);
				}
				const settlementBlock = boundary.number + SETTLEMENT_BLOCKS;
				const latest = await withBackoff(() =>
					getBlock(args.consensusClient, { blockTag: "latest" }),
				);
				if (latest.number !== null && latest.number >= settlementBlock) {
					await withBackoff(() => getBlock(args.consensusClient, { blockNumber: settlementBlock }));
					settled = true;
				}
			} catch (error) {
				if (!(error instanceof TimestampAfterLatestBlockError)) throw error;
			}
			output = canonicalJson({ previousCid: previous.cid.toString(), period, settled });
		} finally {
			await rm(temporary, { force: true, recursive: true });
		}
		process.stdout.write(output);
	},
);
