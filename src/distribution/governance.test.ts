import {
	type Address,
	createClient,
	custom,
	decodeFunctionData,
	encodeFunctionResult,
	type Hex,
	namehash,
	toHex,
	zeroAddress,
} from "viem";
import { describe, expect, it } from "vitest";
import { CONFIG, ENS_NAME, ENS_NODE } from "../../tests/harness/governance.js";
import { namedAddress } from "../../tests/harness/utils.js";
import { ENS_REGISTRY_ABI, REALITY_ETH_ERC20_ABI, REALITY_MODULE_ABI } from "../abi.js";
import { backoff } from "../utils/backoff.js";
import { governanceConfiguration } from "./governance.js";
import { ENS_REGISTRY } from "./previous.js";

// The mainnet block the `CONFIG` vector was read at.
const BLOCK_NUMBER = 26247049n;
const LATEST_BLOCK_NUMBER = 26250000n;

// Retries each failed request twice, without waiting.
const fastBackoff = backoff({ delays: [0, 0] });

type Chain = {
	target?: Address;
	resolver?: Address;
	failures?: number;
};

/**
 * A fake mainnet that serves the getters of the Reality Module, its oracle's `token()` and the ENS
 * registry with the `CONFIG` vector, recording the block tag of every call. The first `failures`
 * calls fail, to exercise the backoff.
 */
const fakeChain = ({
	target = CONFIG.avatar,
	resolver = CONFIG.ensResolver,
	failures = 0,
}: Chain) => {
	const calls: { functionName: string; blockTag: string }[] = [];
	let blockNumberRequests = 0;
	const client = createClient({
		transport: custom({
			async request({ method, params }) {
				if (method === "eth_blockNumber") {
					blockNumberRequests++;
					return toHex(LATEST_BLOCK_NUMBER);
				}
				if (method !== "eth_call") {
					throw new Error(`unsupported JSON-RPC method "${method}"`);
				}
				if (failures-- > 0) {
					throw new Error("flaky node");
				}
				const [{ to, data }, blockTag] = params as [{ to: Address; data: Hex }, string];
				if (to.toLowerCase() === CONFIG.module.toLowerCase()) {
					const { functionName } = decodeFunctionData({ abi: REALITY_MODULE_ABI, data });
					calls.push({ functionName, blockTag });
					const results: Record<string, unknown> = {
						avatar: CONFIG.avatar,
						target,
						oracle: CONFIG.oracle,
						template: CONFIG.templateId,
						questionArbitrator: CONFIG.arbitrator,
						minimumBond: CONFIG.minimumBond,
						questionTimeout: Number(CONFIG.questionTimeout),
						questionCooldown: Number(CONFIG.questionCooldown),
						answerExpiration: Number(CONFIG.answerExpiration),
					};
					if (!(functionName in results)) {
						throw new Error(`unexpected module call ${functionName}`);
					}
					return encodeFunctionResult({
						abi: REALITY_MODULE_ABI,
						functionName,
						result: results[functionName],
					} as never);
				}
				if (to.toLowerCase() === CONFIG.oracle.toLowerCase()) {
					const { functionName } = decodeFunctionData({ abi: REALITY_ETH_ERC20_ABI, data });
					expect(functionName).toBe("token");
					calls.push({ functionName, blockTag });
					return encodeFunctionResult({
						abi: REALITY_ETH_ERC20_ABI,
						functionName: "token",
						result: CONFIG.bondToken,
					});
				}
				if (to.toLowerCase() === ENS_REGISTRY.toLowerCase()) {
					const { functionName, args } = decodeFunctionData({ abi: ENS_REGISTRY_ABI, data });
					expect(args).toEqual([ENS_NODE]);
					calls.push({ functionName, blockTag });
					return encodeFunctionResult({
						abi: ENS_REGISTRY_ABI,
						functionName: "resolver",
						result: resolver,
					});
				}
				throw new Error(`unexpected call to ${to}`);
			},
		}),
	});
	return { client, calls, blockNumberRequests: () => blockNumberRequests };
};

const GETTERS = [
	"answerExpiration",
	"avatar",
	"minimumBond",
	"oracle",
	"questionArbitrator",
	"questionCooldown",
	"questionTimeout",
	"resolver",
	"target",
	"template",
	"token",
];

describe("governanceConfiguration", () => {
	it("reads the mainnet configuration at one block", async () => {
		const chain = fakeChain({});

		const config = await governanceConfiguration(
			chain.client,
			{ module: CONFIG.module, ensName: ENS_NAME, blockNumber: BLOCK_NUMBER },
			{ withBackoff: fastBackoff },
		);

		expect(config).toEqual(CONFIG);
		expect(namehash(ENS_NAME)).toBe(ENS_NODE);
		expect(chain.calls.map(({ functionName }) => functionName).sort()).toEqual(GETTERS);
		expect(chain.calls.map(({ blockTag }) => blockTag)).toEqual(
			Array(GETTERS.length).fill(toHex(BLOCK_NUMBER)),
		);
		expect(chain.blockNumberRequests()).toBe(0);
	});

	it("reads everything at the latest block when no block is given", async () => {
		const chain = fakeChain({});

		expect(
			await governanceConfiguration(
				chain.client,
				{ module: CONFIG.module, ensName: ENS_NAME },
				{ withBackoff: fastBackoff },
			),
		).toEqual(CONFIG);
		expect(chain.blockNumberRequests()).toBe(1);
		expect(chain.calls.map(({ blockTag }) => blockTag)).toEqual(
			Array(GETTERS.length).fill(toHex(LATEST_BLOCK_NUMBER)),
		);
	});

	it("retries failed calls", async () => {
		const chain = fakeChain({ failures: 2 });

		expect(
			await governanceConfiguration(
				chain.client,
				{ module: CONFIG.module, ensName: ENS_NAME, blockNumber: BLOCK_NUMBER },
				{ withBackoff: fastBackoff },
			),
		).toEqual(CONFIG);
	});

	it("refuses a module whose target is not its avatar", async () => {
		const target = namedAddress("target");
		const chain = fakeChain({ target });

		await expect(
			governanceConfiguration(
				chain.client,
				{ module: CONFIG.module, ensName: ENS_NAME, blockNumber: BLOCK_NUMBER },
				{ withBackoff: fastBackoff },
			),
		).rejects.toThrow(
			`Reality Module ${CONFIG.module} has avatar ${CONFIG.avatar} but target ${target}`,
		);
	});

	it("refuses a name without a resolver", async () => {
		const chain = fakeChain({ resolver: zeroAddress });

		await expect(
			governanceConfiguration(
				chain.client,
				{ module: CONFIG.module, ensName: ENS_NAME, blockNumber: BLOCK_NUMBER },
				{ withBackoff: fastBackoff },
			),
		).rejects.toThrow(`ENS name ${ENS_NAME} has no resolver`);
	});
});
