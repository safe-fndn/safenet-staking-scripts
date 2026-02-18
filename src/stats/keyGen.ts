import type { Address, Hex, PublicClient } from "viem";
import { COORDINATOR_KEY_GEN_EVENTS } from "../utils/events.js";
import { getLogsBatched } from "../utils/query.js";

export type KeyGenStats = {
	gid: Hex;
	initiatedAt: bigint;
	committed: bigint[];
	secrets: bigint[];
	confirmed: bigint[];
	completed: boolean;
	lastUpdatedAt: bigint;
	lastUpdatedBy: bigint;
};

export const getKeyGenStats = async (
	client: PublicClient,
	coordinator: Address,
	startBlock: bigint,
	targetBlock: bigint,
) => {
	const query = {
		address: coordinator,
		events: COORDINATOR_KEY_GEN_EVENTS,
	};
	const logs = await getLogsBatched(client, startBlock, targetBlock, query);
	return logs.reduce(
		(agg, event) => {
			const gid = event.args.gid as Hex;
			const groupStats = agg[gid] ?? {
				gid,
				initiatedAt: 0n,
                lastUpdatedAt: 0n,
                lastUpdatedBy: 0n,
				committed: [],
				secrets: [],
				confirmed: [],
				completed: false,
			};
			switch (event.eventName) {
				case "KeyGen": {
					groupStats.initiatedAt = event.blockNumber;
					break;
				}
				case "KeyGenCommitted": {
					groupStats.lastUpdatedAt = event.blockNumber;
					groupStats.lastUpdatedBy = event.args.identifier as bigint;
					groupStats.committed.push(event.args.identifier as bigint);
					break;
				}
				case "KeyGenSecretShared": {
					groupStats.lastUpdatedAt = event.blockNumber;
					groupStats.lastUpdatedBy = event.args.identifier as bigint;
					groupStats.secrets.push(event.args.identifier as bigint);
					break;
				}
				case "KeyGenConfirmed": {
					if (event.args.confirmed) {
						groupStats.completed = true;
					}
					groupStats.lastUpdatedAt = event.blockNumber;
					groupStats.lastUpdatedBy = event.args.identifier as bigint;
					groupStats.confirmed.push(event.args.identifier as bigint);
					break;
				}
			}
			agg[gid] = groupStats;
			return agg;
		},
		{} as Record<string, KeyGenStats>,
	);
};

export const logKeyGenStats = (aggregation: Record<string, KeyGenStats>, displayFailed: boolean) => {
	const totalKeyGens = Object.values(aggregation).filter((kg) => kg.initiatedAt > 0);
	const completedKeyGens = totalKeyGens.filter((kg) => kg.completed);
	const validatorStats = {} as Record<string, number>;
	console.log(`Tracked ${totalKeyGens.length} key generations with ${completedKeyGens.length} completed`);
	for (const details of completedKeyGens) {
		for (const validator of details.confirmed) {
			validatorStats[validator.toString()] = (validatorStats[validator.toString()] ?? 0) + 1;
		}
	}

	const validators = Object.entries(validatorStats);
	console.log(`Tracked ${validators.length} validators`);
	for (const [validatorId, confirmed] of validators) {
		console.log();
		console.log(`Validator with index ${validatorId}`);
		console.log(`Confirmed ${confirmed}/${completedKeyGens.length} (${(100 * confirmed) / completedKeyGens.length}%)`);
	}

	const incompletedKeyGens = totalKeyGens.filter((kg) => !kg.completed);
	if (displayFailed && incompletedKeyGens.length > 0) {
		console.log(`Following ${incompletedKeyGens.length} key generations were not completed:`);
		for (const details of incompletedKeyGens) {
			console.log();
			console.log(`Key gen for group ${details.gid}`);
			console.log(`Initiated at ${details.initiatedAt}`);
			console.log(`Last updated at ${details.lastUpdatedAt}`);
			console.log(`Last updated by ${details.lastUpdatedBy}`);
			console.log(`Committed to by ${details.committed.sort()}`);
			console.log(`Secrets shared by ${details.secrets.sort()}`);
			console.log(`Confirmed by ${details.confirmed.sort()}`);
		}
	}
};
