/**
 * Command to build a reward distribution package and its release assets on top of the rewards DB
 * that the ENS `contenthash` pins, for the two-week period that follows it.
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress } from "viem";
import { z } from "zod";
import { exportPackage } from "../distribution/export.js";
import { releaseAssets, writeReleaseAssets } from "../distribution/release.js";
import { Safenet } from "../safenet.js";
import { main } from "../utils/args.js";
import { formatSafeToken, formatTimestamp } from "../utils/format.js";

const amount = (value: bigint): string => formatSafeToken(value).trim();

main(
	{
		previousCar: z.string().min(1).optional(),
		ipfsGatewayUrl: z.url().optional(),
		cumulativeMerkleDropAddress: z.string().transform((v) => getAddress(v)),
		realityModuleAddress: z.string().transform((v) => getAddress(v)),
		rewardsEnsName: z.string().min(1),
		out: z.string().min(1),
	},
	async (args) => {
		// Before any RPC, so that an output directory that the release assets could not be
		// written to fails right away.
		if ((await readdir(args.out).catch(() => [])).length > 0) {
			throw new Error(`release directory ${JSON.stringify(args.out)} is not empty`);
		}

		const safenet = await Safenet.create(args);
		// The package is assembled outside of `--out`, which only holds the release assets.
		const temporary = await mkdtemp(join(tmpdir(), "safenet-package-"));
		try {
			const result = await exportPackage(safenet, args, join(temporary, "package"));
			await writeReleaseAssets(args.out, releaseAssets(result));

			let validatorRewards = 0n;
			let sentinelRewards = 0n;
			for (const split of Object.values(result.payouts)) {
				validatorRewards += split.stakeRewards + split.commission;
				sentinelRewards += split.sentinelRewards;
			}
			console.log(`Previous CID:       ${result.previous.cid}`);
			console.log(
				`Period:             ${formatTimestamp(result.period.fromTimestamp)} → ` +
					`${formatTimestamp(result.period.toTimestamp)}, ` +
					`settled at consensus block ${result.settlement.settlementBlock}`,
			);
			console.log(`Package CID:        ${result.cid}`);
			console.log(`Merkle Root:        ${result.merkleRoot}`);
			console.log(`Additional Amount:  ${amount(result.additionalAmount)}`);
			console.log(
				`Validator Rewards:  ${amount(validatorRewards)} of ${amount(result.totalRewards)} ` +
					`(unpaid ${amount(result.unpaid)})`,
			);
			console.log(
				`Sentinel Rewards:   ${amount(sentinelRewards)} ` +
					`(${amount(result.sentinelRewards)} each, forfeited ${amount(result.forfeited)})`,
			);
			console.log(`Sanctions Lists:    ${result.sanctionsRelease}`);
			console.log(`Transaction Hash:   ${result.proposal.transaction.hash}`);
			console.log(`Question ID:        ${result.proposal.questionId}`);
			for (const account of result.newlyApproved) {
				console.log(`New KYC Approval:   ${account}`);
			}
			console.log(`Release Assets:     ${args.out}`);
		} finally {
			await rm(temporary, { force: true, recursive: true });
		}
	},
);
