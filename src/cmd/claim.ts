/** Writes the bundle that claims the bonds of a finalized Reality Module question. */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Hex } from "viem";
import { getBlockNumber, getChainId, readContract } from "viem/actions";
import { z } from "zod";
import { REALITY_MODULE_ABI } from "../abi.js";
import { AEGIS } from "../config/aegis.js";
import { claimArguments, claimBundle, questionClaim } from "../distribution/claim.js";
import { GOVERNANCE_CHAIN_ID } from "../distribution/transactions.js";
import { main } from "../utils/args.js";
import { backoff } from "../utils/backoff.js";
import { formatSafeToken, formatTimestamp } from "../utils/format.js";
import { canonicalJson } from "../utils/json.js";

const amount = (value: bigint): string => `${formatSafeToken(value).trim()} SAFE`;

main(
	{
		question: z
			.string()
			.regex(/^0x[0-9a-fA-F]{64}$/, "expected a 32-byte question ID")
			.transform((value) => value.toLowerCase() as Hex),
		out: z.string().min(1),
	},
	async (args) => {
		const client = args.stakingClient;
		const withBackoff = backoff();
		const chainId = await withBackoff(() => getChainId(client));
		if (chainId !== GOVERNANCE_CHAIN_ID) {
			throw new Error(`staking chain ${chainId} is not the governance chain`);
		}
		const blockNumber = await withBackoff(() => getBlockNumber(client, { cacheTime: 0 }));
		const oracle = await withBackoff(() =>
			readContract(client, {
				address: AEGIS.ethereum.realityModule,
				abi: REALITY_MODULE_ABI,
				functionName: "oracle",
				blockNumber,
			}),
		);
		const claim = await questionClaim(
			client,
			{ oracle, questionId: args.question, blockNumber },
			{ withBackoff },
		);
		const bundle = claimBundle(oracle, claim);
		const unclaimed = claimArguments(claim);

		await mkdir(args.out, { recursive: true });
		const file = join(args.out, "claim.json");
		// `wx` refuses to overwrite an earlier bundle.
		await writeFile(file, canonicalJson(bundle), { encoding: "utf8", flag: "wx" });

		console.log(`Question ID:        ${claim.questionId}`);
		console.log(`Oracle:             ${oracle}`);
		console.log(`Onchain Block:      ${claim.blockNumber}`);
		console.log(`Finalized:          ${formatTimestamp(claim.finalizeTimestamp)}`);
		for (const [i, user] of unclaimed.addrs.entries()) {
			console.log(
				`Claimed Answer:     ${unclaimed.answers[i]} by ${user}, ` +
					`bond ${amount(unclaimed.bonds[i])}`,
			);
		}
		for (const [user, balance] of Object.entries(claim.balances)) {
			console.log(`Oracle Balance:     ${user} ${amount(balance)}`);
		}
		console.log(`Claim Bundle:       ${file}`);
	},
);
