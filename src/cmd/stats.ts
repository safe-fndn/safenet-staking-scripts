import { parseArgs } from "node:util";
import { configDotenv } from "dotenv";
import { createPublicClient, http, type PublicClient } from "viem";
import z from "zod";
import { getKeyGenStats, logKeyGenStats } from "../stats/keyGen.js";
import { getSigningStats, logSigningStats } from "../stats/signing.js";
import { CONSENSUS_FUNCTIONS } from "../utils/functions.js";
import { checkedAddressSchema } from "../utils/schemas.js";

configDotenv({ quiet: true });

const OptionsSchema = z.object({
	consensus: checkedAddressSchema,
	fromBlock: z.coerce.bigint(),
	toBlock: z.coerce.bigint().optional(),
	includeKeyGens: z.coerce.boolean().default(false),
	displayFailed: z.coerce.boolean().default(false),
});

const main = async (
	client: PublicClient,
	{ consensus, fromBlock, toBlock, includeKeyGens, displayFailed }: z.infer<typeof OptionsSchema>,
): Promise<void> => {
	// Calculate participation in a specific block range

	// 1. Calculate key gen participation
	// - Fetch key gen events
	// - Fetch events for each step

	// 2. Calculate signing participation
	// - Fetch sign events
	// - Fetch events for each step
	// - Group events and check against threshold
	//   -> Below threshold participation == tx is invalid, whoever participated should be discounted
	//   -> Equal or above threshold participation == tx is valid, whoever did not participate should be discounted

	const coordinator = await client.readContract({
		address: consensus,
		abi: CONSENSUS_FUNCTIONS,
		functionName: "COORDINATOR",
	});
	console.log({ consensus, coordinator });
	const targetBlock = toBlock ?? (await client.getBlockNumber());
	const startBlock = fromBlock < 0 ? targetBlock + fromBlock : fromBlock;
	if (includeKeyGens) {
		const keyGenStats = await getKeyGenStats(client, coordinator, startBlock, targetBlock);
		logKeyGenStats(keyGenStats, displayFailed);
		console.log();
	}
	const signingStats = await getSigningStats(client, coordinator, startBlock, targetBlock);
	logSigningStats(signingStats, displayFailed);
};

const { RPC_URL, CONSENSUS_ADDRESS } = z
	.object({
		RPC_URL: z.url(),
		CONSENSUS_ADDRESS: z.union([z.literal(""), checkedAddressSchema]).optional(),
	})
	.parse(process.env);

const { values } = parseArgs({
	options: {
		consensus: { type: "string", short: "c" },
		fromBlock: { type: "string", short: "f" },
		toBlock: { type: "string", short: "t" },
		includeKeyGens: { type: "boolean", short: "k" },
		displayFailed: { type: "boolean", short: "e" },
	},
});

const client = createPublicClient({
	transport: http(RPC_URL),
});

main(client, OptionsSchema.parse({ consensus: CONSENSUS_ADDRESS, ...values })).catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
