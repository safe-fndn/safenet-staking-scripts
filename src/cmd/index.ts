/**
 * Command to pre-fetch events used by the accounting scripts and index them
 * into the database cache.
 */

import { parseArgs } from "node:util";
import { configDotenv } from "dotenv";
import { createClient, getAddress, http } from "viem";
import { z } from "zod";
import { Safenet } from "../safenet.js";

configDotenv({ quiet: true });

const argsSchema = z.object({
	databaseFile: z.string().min(1),
	stakingRpcUrl: z.url(),
	stakingAddress: z.string().transform((a) => getAddress(a)),
	stakingStartBlock: z.coerce.bigint(),
	consensusRpcUrl: z.url(),
	consensusAddress: z.string().transform((a) => getAddress(a)),
	consensusStartBlock: z.coerce.bigint(),
	blockPageSize: z.coerce.bigint(),
});

const main = async () => {
	const args = argsSchema.parse(
		parseArgs({
			options: {
				databaseFile: { type: "string", short: "d", default: process.env.DATABASE_FILE },
				stakingRpcUrl: { type: "string", short: "u", default: process.env.STAKING_RPC_URL },
				stakingAddress: { type: "string", short: "c", default: process.env.STAKING_ADDRESS },
				stakingStartBlock: {
					type: "string",
					short: "s",
					default: process.env.STAKING_START_BLOCK,
				},
				consensusRpcUrl: { type: "string", short: "u", default: process.env.CONSENSUS_RPC_URL },
				consensusAddress: { type: "string", short: "c", default: process.env.CONSENSUS_ADDRESS },
				consensusStartBlock: {
					type: "string",
					short: "s",
					default: process.env.CONSENSUS_START_BLOCK,
				},
				blockPageSize: { type: "string", short: "p", default: process.env.BLOCK_PAGE_SIZE },
			},
		}).values,
	);

	const safenet = await Safenet.create({
		stakingClient: createClient({
			transport: http(args.stakingRpcUrl),
		}),
		consensusClient: createClient({
			transport: http(args.consensusRpcUrl),
		}),
		...args,
	});
	await safenet.index({ blockPageSize: args.blockPageSize });
};

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
