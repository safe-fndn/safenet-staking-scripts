import { decodeEventLog, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { SENTINEL_ORACLE_ABI } from "./abi.js";

// Logs of the Aegis sentinel oracle on Gnosis Chain. The test harness encodes its
// logs with the ABI under test, so only deployed logs catch a layout that no
// longer matches the contract.
const sponsor = "0x0000000000000000000000008ed44000983b5789798b43af9d8d9c1e1e2093d0";
const LOGS: { eventName: string; topics: [Hex, ...Hex[]]; data: Hex }[] = [
	{
		// Block 48752182, log 150.
		eventName: "NewRequest",
		topics: [
			"0x8ec61272960f97d43d7f8f85ed630aa512818577f3d1e548e7627b06dbbbda86",
			"0x6456ad875540c66a75e747b37948d63c8d5f885982e50fa24c06a642c8a8e8eb",
			sponsor,
		],
		data: "0x0000000000000000000000000000000000000000000000000000000000061a80000000000000000000000000000000000000000000000000000000002faf080000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000061a800000000000000000000000000000000000000000000000000000000002e7e63c0000000000000000000000000000000000000000000000000000000002e7e642",
	},
	{
		// Block 48768653, log 83.
		eventName: "OracleResult",
		topics: [
			"0x7843c453c4f7442b00e1bf3873e741f18f3447e18a13304c58bef95efd311757",
			"0x8060456bbdde8491e12512d60cc87d68a4a22ba95555d7fb5a2637e24ced2e2a",
			sponsor,
		],
		data: "0x000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
	},
];

describe("SENTINEL_ORACLE_ABI", () => {
	it.each(LOGS)("decodes a deployed $eventName log", ({ eventName, topics, data }) => {
		const log = decodeEventLog({
			abi: SENTINEL_ORACLE_ABI,
			strict: true,
			topics,
			data,
		});
		expect(log.eventName).toBe(eventName);
		expect(log.args.requestId).toBe(topics[1]);
	});
});
