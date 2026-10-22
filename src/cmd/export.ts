/**
 * Command to build a reward distribution package and its release assets for an explicit period,
 * on top of the rewards DB that the ENS `contenthash` pins.
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, parseUnits } from "viem";
import { z } from "zod";
import { exportPackage } from "../distribution/export.js";
import { generator } from "../distribution/generator.js";
import { releaseAssets, writeReleaseAssets } from "../distribution/release.js";
import { Safenet } from "../safenet.js";
import { main } from "../utils/args.js";
import { formatSafeToken } from "../utils/format.js";

main(
	{
		// A package is only ever built for an explicit period, so there is no default.
		rewardPeriodStart: z.coerce.bigint(),
		rewardPeriodEnd: z.coerce.bigint(),
		totalRewards: z
			.string()
			.transform((v) => parseUnits(v, 18))
			.optional(),
		sentinelRewards: z
			.string()
			.transform((v) => parseUnits(v, 18))
			.optional(),
		minPayout: z
			.string()
			.transform((v) => parseUnits(v, 18))
			.default(0n),
		previousCar: z.string().min(1).optional(),
		ipfsGatewayUrl: z.url().optional(),
		cumulativeMerkleDropAddress: z.string().transform((v) => getAddress(v)),
		realityModuleAddress: z.string().transform((v) => getAddress(v)),
		rewardsEnsName: z.string().min(1),
		out: z.string().min(1),
	},
	async (args) => {
		// Before any RPC, so that an output directory that the release assets could not be written
		// to fails right away.
		const generated = await generator({ warn: (message) => console.warn(`WARNING: ${message}`) });
		if ((await readdir(args.out).catch(() => [])).length > 0) {
			throw new Error(`release directory ${JSON.stringify(args.out)} is not empty`);
		}

		const safenet = await Safenet.create(args);
		// The package is assembled outside of `--out`, which only holds the release assets.
		const temporary = await mkdtemp(join(tmpdir(), "safenet-package-"));
		try {
			const result = await exportPackage(
				safenet,
				args,
				{
					period: { fromTimestamp: args.rewardPeriodStart, toTimestamp: args.rewardPeriodEnd },
					totalRewards: args.totalRewards,
					sentinelRewards: args.sentinelRewards,
					minPayout: args.minPayout,
					generator: generated,
				},
				join(temporary, "package"),
			);
			await writeReleaseAssets(args.out, releaseAssets(result));

			const { manifest, proposal } = result;
			console.log(`Previous CID:       ${manifest.previous.cid}`);
			console.log(`Package CID:        ${result.cid}`);
			console.log(`Merkle Root:        ${manifest.distribution.merkleRoot}`);
			console.log(
				`Additional Amount:  ${formatSafeToken(manifest.distribution.additionalAmount).trim()}`,
			);
			console.log(
				`Total Rewards:      ${formatSafeToken(manifest.parameters.totalRewards).trim()}`,
			);
			console.log(
				`Sentinel Rewards:   ${formatSafeToken(manifest.parameters.sentinelRewards).trim()}`,
			);
			console.log(`Transaction Hash:   ${proposal.transaction.hash}`);
			console.log(`Question ID:        ${proposal.questionId}`);
			for (const account of manifest.kyc.newlyApproved) {
				console.log(`New KYC Approval:   ${account}`);
			}
			console.log(`Release Assets:     ${args.out}`);
		} finally {
			await rm(temporary, { force: true, recursive: true });
		}
	},
);
