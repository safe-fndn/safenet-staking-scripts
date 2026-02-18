import type { AbiEvent, Address, GetLogsReturnType, PublicClient } from "viem";
import { minBigNum } from "./math.js";

type EventQuery<E extends Readonly<AbiEvent[]>> = {
	address: Address;
	events: E;
};

type QueryResult<E extends Readonly<AbiEvent[]>> = GetLogsReturnType<undefined, E>;

export const getLogsBatched = async <E extends Readonly<AbiEvent[]>>(
	client: PublicClient,
	fromBlock: bigint,
	toBlock: bigint,
	query: EventQuery<E>,
	batchSize = 10000n,
): Promise<QueryResult<E>> => {
	const logs = [];
	let currentFrom = fromBlock;
	let currentBatchSize = batchSize;
	while (currentFrom < toBlock && currentBatchSize > 0) {
		const currentTo = minBigNum(currentFrom + currentBatchSize, toBlock);
		try {
			console.debug(`Load batch from ${currentFrom} to ${currentTo}`);
			const logResults = await client.getLogs({
				strict: true,
				...query,
				event: undefined,
				fromBlock: currentFrom,
				toBlock: currentTo,
			});
			console.debug(`${logResults.length} events loaded`);
			logs.push(...logResults);
			currentFrom = currentTo;
			currentBatchSize = batchSize;
		} catch (e: unknown) {
			console.warn(e);
			currentBatchSize = currentBatchSize / 10n;
		}
	}
	return logs;
};
