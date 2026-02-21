import type { Address, Hex, PublicClient } from "viem";
import { COORDINATOR_SIGNING_EVENTS } from "../utils/events.js";
import { getLogsBatched } from "../utils/query.js";

export type SigningStats = {
	sid: Hex;
	initiatedAt: bigint;
	committed: bigint[];
	signed: bigint[];
	completed: boolean;
	lastUpdatedAt: bigint;
	lastUpdatedBy: bigint;
};

export const getSigningStats = async (
	client: PublicClient,
	coordinator: Address,
	startBlock: bigint,
	targetBlock: bigint,
) => {
	const query = {
		address: coordinator,
		events: COORDINATOR_SIGNING_EVENTS,
	};
	const logs = await getLogsBatched(client, startBlock, targetBlock, query);
	return logs.reduce(
		(agg, event) => {
			const sid = event.args.sid as Hex;
			const signingStats = agg[sid] ?? {
				sid,
				initiatedAt: 0n,
				lastUpdatedAt: 0n,
				lastUpdatedBy: 0n,
				committed: [],
				signed: [],
				completed: false,
			};
			switch (event.eventName) {
				case "Sign": {
					signingStats.initiatedAt = event.blockNumber;
					break;
				}
				case "SignRevealedNonces": {
					signingStats.lastUpdatedAt = event.blockNumber;
					signingStats.lastUpdatedBy = event.args.identifier as bigint;
					signingStats.committed.push(event.args.identifier as bigint);
					break;
				}
				case "SignShared": {
					signingStats.lastUpdatedAt = event.blockNumber;
					signingStats.lastUpdatedBy = event.args.identifier as bigint;
					signingStats.signed.push(event.args.identifier as bigint);
					break;
				}
				case "SignCompleted": {
					signingStats.completed = true;
					break;
				}
			}
			agg[sid] = signingStats;
			return agg;
		},
		{} as Record<string, SigningStats>,
	);
};

export const logSigningStats = (
	aggregation: Record<string, SigningStats>,
	displayFailed: boolean,
) => {
	// Only consider signing requests where at least one validator interacted
	// TODO: filter on expected group id and consider non-valid requests in the total
	const totalRequests = Object.values(aggregation).filter(
		(sr) => sr.initiatedAt > 0 && sr.committed.length > 0,
	);

	const completedRequests = totalRequests.filter((sr) => sr.completed);
	const validatorStats = {} as Record<string, { completed: number; invalid: number }>;
	console.log(
		`Tracked ${totalRequests.length} signing requests with ${completedRequests.length} signed by threshold (aka completed)`,
	);
	for (const details of totalRequests) {
		for (const validator of details.signed) {
			const stats = validatorStats[validator.toString()] ?? { completed: 0, invalid: 0 };
			if (details.completed) {
				stats.completed++;
			} else {
				stats.invalid++;
			}
			validatorStats[validator.toString()] = stats;
		}
	}

	const invalidRequests = totalRequests.filter((sr) => !sr.completed);
	const validators = Object.entries(validatorStats);
	console.log(`Tracked ${validators.length} validators`);
	for (const [validatorId, stats] of validators) {
		console.log();
		console.log(`Validator with index ${validatorId}`);
		console.log(
			`Confirmed ${stats.completed}/${completedRequests.length} (${(100 * stats.completed) / completedRequests.length}%)`,
		);
		if (invalidRequests.length > 0) {
			console.log(
				`Invalid ${stats.invalid}/${invalidRequests.length} (${(100 * stats.invalid) / invalidRequests.length}%)`,
			);
		}
	}

	if (displayFailed && invalidRequests.length > 0) {
		console.log(`Following ${invalidRequests.length} signing requests were invalid`);
		for (const details of invalidRequests) {
			console.log();
			console.log(`Signing ${details.sid}`);
			console.log(`Initiated at ${details.initiatedAt}`);
			console.log(`Last updated at ${details.lastUpdatedAt}`);
			console.log(`Last updated by ${details.lastUpdatedBy}`);
			console.log(`Committed to by ${details.committed.sort()}`);
			console.log(`Signed by ${details.signed.sort()}`);
		}
	}
};
