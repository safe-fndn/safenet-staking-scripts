import { Address, createPublicClient, Hex, http, PublicClient, zeroAddress } from "viem";
import { COORDINATOR_KEY_GEN_EVENTS } from "./utils/events.js";
import { parseArgs } from "util";
import z from "zod";
import { checkedAddressSchema } from "./utils/schemas.js";
import { configDotenv } from "dotenv";
import { CONSENSUS_FUNCTIONS } from "./utils/functions.js";
import { getLogsBatched } from "./utils/query.js";

type GroupStats = {
    gid: Hex,
    initiatedAt: bigint,
    committed: bigint[],
    secrets: bigint[],
    confirmed: bigint[],
    completed: boolean,
    lastUpdatedAt: bigint, 
    lastUpdatedBy: bigint, 
}

configDotenv({ quiet: true });

const OptionsSchema = z.object({
  consensus: checkedAddressSchema,
  fromBlock: z.coerce.bigint(),
  toBlock: z.coerce.bigint().optional(),
  displayFailedKeyGen: z.coerce.boolean().default(false),
  displayFailedSigning: z.coerce.boolean().default(false),
});

const main = async (client: PublicClient, {
    consensus, 
    fromBlock, 
    toBlock,
    displayFailedKeyGen,
    displayFailedSigning
}: z.infer<typeof OptionsSchema>): Promise<void> => {
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
        functionName: "COORDINATOR"
    })
    console.log({coordinator});
    const query = {
        address: coordinator,
        events: COORDINATOR_KEY_GEN_EVENTS
    }
    const targetBlock = toBlock ?? await client.getBlockNumber()
    const startBlock = fromBlock < 0 ? targetBlock + fromBlock : fromBlock;
    const logs = await getLogsBatched(client, startBlock, targetBlock, query)
    const aggregation = logs.reduce((agg, event) => {
        const gid = event.args.gid as Hex
        const groupStats = agg[gid] ?? { 
            gid,
            initiatedAt: 0n,
            lastUpdate: 0n,
            committed: [],
            secrets: [],
            confirmed: [],
            completed: false
        }
        switch(event.eventName) {
            case 'KeyGen': {
                groupStats.initiatedAt = event.blockNumber
                break;
            }
            case "KeyGenCommitted": {
                groupStats.lastUpdatedAt = event.blockNumber
                groupStats.lastUpdatedBy = event.args.identifier as bigint
                groupStats.committed.push(event.args.identifier as bigint)
                break;
            }
            case "KeyGenSecretShared":{
                groupStats.lastUpdatedAt = event.blockNumber
                groupStats.lastUpdatedBy = event.args.identifier as bigint
                groupStats.secrets.push(event.args.identifier as bigint)
                break;
            }
            case "KeyGenConfirmed":{
                if (event.args.confirmed) {
                    groupStats.completed = true;
                }
                groupStats.lastUpdatedAt = event.blockNumber
                groupStats.lastUpdatedBy = event.args.identifier as bigint
                groupStats.confirmed.push(event.args.identifier as bigint)
                break;
            }
        }
        agg[gid] = groupStats
        return agg
    }, {} as Record<string, GroupStats>)

    const totalKeyGens = Object.values(aggregation).filter((kg) => kg.initiatedAt > 0)
    const completedKeyGens = totalKeyGens.filter((kg) => kg.completed)
    const validatorStats = {} as Record<string, number>
    console.log(`Tracked ${totalKeyGens.length} key generations with ${completedKeyGens.length} completed`)
    for (const details of completedKeyGens) {
        for (const validator of details.confirmed) {
            validatorStats[validator.toString()] =((validatorStats[validator.toString()]) ?? 0) + 1;
        }
    }

    const validators = Object.entries(validatorStats)
    console.log(`Tracked ${validators.length} validators`)
    for (const [validatorId, confirmed] of validators) {
        console.log()
        console.log(`Validator with index ${validatorId}`)
        console.log(`Confirmed ${confirmed}/${completedKeyGens.length} (${100*confirmed/completedKeyGens.length}%)`)
        console.log()
    }

    if (displayFailedKeyGen) {
        const incompletedKeyGens = totalKeyGens.filter((kg) => !kg.completed)
        console.log(`Following ${incompletedKeyGens.length} key generations were not completed`)
        for (const details of incompletedKeyGens) {
            console.log()
            console.log(`Key gen for group ${details.gid}`)
            console.log(`Initiated at ${details.initiatedAt}`)
            console.log(`Last updated at ${details.lastUpdatedAt}`)
            console.log(`Last updated by ${details.lastUpdatedBy}`)
            console.log(`Committed to by ${details.committed.sort()}`)
            console.log(`Secrets shared by ${details.secrets.sort()}`)
            console.log(`Confirmed by ${details.confirmed.sort()}`)
            console.log()
        }
    }
}

const {
    RPC_URL,
    CONSENSUS_ADDRESS
} = z.object({
  RPC_URL: z.url(),
  CONSENSUS_ADDRESS: z.union([z.literal(""), checkedAddressSchema]).optional()
}).parse(process.env);

const { values } = parseArgs({
  options: {
    consensus: { type: "string", short: "c" },
    fromBlock: { type: "string", short: "f" },
    toBlock: { type: "string", short: "t" },
    displayFailedKeyGen: { type: "boolean", short: "k" },
    displayFailedSigning: { type: "boolean", short: "s" },
  },
});

const client = createPublicClient({
    transport: http(RPC_URL)
})

main(client, OptionsSchema.parse({ consensus: CONSENSUS_ADDRESS, ...values})).catch((err) => {
	console.error(err);
	process.exitCode = 1;
});