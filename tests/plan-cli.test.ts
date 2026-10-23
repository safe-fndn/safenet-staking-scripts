import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { custom, encodeFunctionResult, type Hex, toHex, zeroAddress, zeroHash } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CUMULATIVE_MERKLE_DROP_ABI, ENS_REGISTRY_ABI, ENS_RESOLVER_ABI } from "../src/abi.js";
import { packDirectory } from "../src/distribution/ipfs.js";
import { ENS_REGISTRY } from "../src/distribution/previous.js";
import { encodeContenthash } from "../src/distribution/transactions.js";
import { canonicalJson } from "../src/utils/json.js";
import { AEGIS_REWARDS_START, BETA_REWARDS_UNTIL } from "../src/utils/sep.js";
import { namedAddress } from "./harness/utils.js";

const mocks = vi.hoisted(() => ({ clients: [] as unknown[], directories: [] as string[] }));
vi.mock("viem", async (original) => ({
	...(await original<typeof import("viem")>()),
	createClient: vi.fn(() => mocks.clients.shift()),
}));
vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	return {
		...fs,
		mkdtemp: async (prefix: string) => {
			const dir = await fs.mkdtemp(prefix);
			if (prefix.includes("safenet-plan-")) mocks.directories.push(dir);
			return dir;
		},
	};
});
vi.mock("../src/utils/backoff.js", () => ({
	backoff: () => (query: () => Promise<unknown>) => query(),
}));
vi.mock("dotenv", () => ({ configDotenv: vi.fn() }));
// Any event DB initialization would fail this suite immediately.
vi.mock("better-sqlite3", () => ({
	default: vi.fn(() => {
		throw new Error("opened event DB");
	}),
}));

const { createClient } = await vi.importActual<typeof import("viem")>("viem");
const originalArgv = process.argv;
let originalExitCode: typeof process.exitCode;
const TWO_WEEKS = 1209600n;
const RESOLVER = namedAddress("resolver");
const DROP = namedAddress("drop");
let fixture: string;
let cid: string;
let end: bigint;
let head: bigint;
let offset: bigint;
let chainId: number;
let resolver: typeof RESOLVER;
let root: Hex;
let fail: string | undefined;
let requests: string[];
let stdout: string;

beforeEach(async () => {
	vi.resetModules();
	originalExitCode = process.exitCode;
	process.exitCode = 0;
	stdout = "";
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		stdout += String(chunk);
		return true;
	});
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	const environment = {
		DATABASE_FILE: "/must-not-open.db",
		STAKING_RPC_URL: "https://staking.invalid",
		STAKING_BLOCK_PAGE_SIZE: "100",
		STAKING_ADDRESS: namedAddress("staking"),
		STAKING_START_BLOCK: "1",
		DELEGATE_REGISTRY_ADDRESS: namedAddress("delegates"),
		SANCTIONS_LIST_ADDRESS: namedAddress("sanctions"),
		SANCTIONS_LIST_START_BLOCK: "1",
		CONSENSUS_RPC_URL: "https://consensus.invalid",
		CONSENSUS_ADDRESS: namedAddress("consensus"),
		CONSENSUS_START_BLOCK: "1",
		CONSENSUS_BLOCK_PAGE_SIZE: "25",
		SENTINEL_ORACLE_ADDRESS: namedAddress("oracle"),
		SENTINEL_ORACLE_START_BLOCK: "1",
		CUMULATIVE_MERKLE_DROP_ADDRESS: DROP,
		REWARDS_ENS_NAME: "rewards.safenet-gov.eth",
	};
	for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
	for (const key of ["PREVIOUS_CAR", "IPFS_GATEWAY_URL", "REALITY_MODULE_ADDRESS", "DEBUG"])
		vi.stubEnv(key, undefined);
	fixture = await mkdtemp(join(tmpdir(), "safenet-plan-test-"));
	end = AEGIS_REWARDS_START + TWO_WEEKS;
	head = 148n;
	offset = 0n;
	chainId = 1;
	resolver = RESOLVER;
	root = zeroHash;
	fail = undefined;
	requests = [];
	mocks.directories.length = 0;
	await previous(BETA_REWARDS_UNTIL);
	const staking = createClient({
		transport: custom(
			{
				request: async ({ method, params }) => {
					requests.push(method);
					if (fail === method) throw new Error("RPC failed");
					if (method === "eth_chainId") return toHex(chainId);
					if (method === "eth_blockNumber") return "0xabc";
					if (method !== "eth_call") throw new Error(`unexpected ${method}`);
					const [{ to }, block] = params as [{ to: string }, string];
					expect(block).toBe("0xabc");
					if (to.toLowerCase() === ENS_REGISTRY.toLowerCase())
						return encodeFunctionResult({
							abi: ENS_REGISTRY_ABI,
							functionName: "resolver",
							result: resolver,
						});
					if (to.toLowerCase() === RESOLVER.toLowerCase())
						return encodeFunctionResult({
							abi: ENS_RESOLVER_ABI,
							functionName: "contenthash",
							result: encodeContenthash((await packDirectory(fixture)).cid),
						});
					if (to.toLowerCase() === DROP.toLowerCase())
						return encodeFunctionResult({
							abi: CUMULATIVE_MERKLE_DROP_ABI,
							functionName: "merkleRoot",
							result: root,
						});
					throw new Error(`unexpected contract ${to}`);
				},
			},
			{ retryCount: 0 },
		),
	});
	const consensus = createClient({
		transport: custom(
			{
				request: async ({ method, params }) => {
					requests.push(method);
					if (fail === method) throw new Error("RPC failed");
					if (method !== "eth_getBlockByNumber") throw new Error(`unexpected ${method}`);
					const [tag] = params as [string];
					const number = tag === "latest" ? head : BigInt(tag);
					if (fail === "settlement" && tag !== "latest" && number === 148n)
						throw new Error("settlement RPC failed");
					if (number > head) return null;
					return { number: toHex(number), timestamp: toHex(end + (number - 100n) * 5n + offset) };
				},
			},
			{ retryCount: 0 },
		),
	});
	mocks.clients = [staking, consensus];
});

const previous = async (until: bigint) => {
	await writeFile(
		join(fixture, "latest.json"),
		canonicalJson({
			epoch: 0,
			merkleRoot: zeroHash,
			rewardsUntil: new Date(Number(until) * 1000),
			tokenTotal: 0n,
		}),
	);
	cid = (await packDirectory(fixture)).cid.toString();
};

const run = async (...flags: string[]) => {
	process.argv = [originalArgv[0], "src/cmd/plan.ts", ...flags];
	await import("../src/cmd/plan.js");
	await vi.waitFor(
		() => expect(stdout !== "" || vi.mocked(console.error).mock.calls.length > 0).toBe(true),
		{ interval: 1 },
	);
	for (const dir of mocks.directories) await expect(access(dir)).rejects.toThrow();
	expect(console.log).not.toHaveBeenCalled();
	return stdout === "" ? undefined : JSON.parse(stdout);
};

afterEach(async () => {
	process.argv = originalArgv;
	process.exitCode = originalExitCode;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	await rm(fixture, { recursive: true, force: true });
	await Promise.all(mocks.directories.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("cmd:plan", () => {
	it("prints only canonical JSON across the Beta → Aegis gap, settled at exactly block +48", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(Uint8Array.from((await packDirectory(fixture)).car))),
		);
		const result = await run();
		expect(result).toEqual({
			previousCid: cid,
			period: { fromTimestamp: String(AEGIS_REWARDS_START), toTimestamp: String(end) },
			settled: true,
		});
		expect(stdout).toBe(canonicalJson(result));
		expect(fetch).toHaveBeenCalledOnce();
		expect(requests).not.toContain("eth_getLogs");
		expect(mocks.directories).toHaveLength(1);
		expect(process.exitCode).toBe(0);
	});

	it("derives the next two weeks from a later rewards DB and accepts CAR/gateway flags", async () => {
		await previous(end);
		end += TWO_WEEKS;
		const car = join(tmpdir(), `${fixture.split("/").at(-1)}.car`);
		await writeFile(car, (await packDirectory(fixture)).car);
		try {
			const result = await run("--previousCar", car, "--ipfsGatewayUrl", "https://gateway.invalid");
			expect(result).toEqual({
				previousCid: cid,
				period: { fromTimestamp: String(end - TWO_WEEKS), toTimestamp: String(end) },
				settled: true,
			});
		} finally {
			await rm(car, { force: true });
		}
	});

	it.each([
		99n,
		100n,
		147n,
	])("succeeds unsettled at head %s (not ended, boundary, or missing 48th block)", async (latest) => {
		head = latest;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(Uint8Array.from((await packDirectory(fixture)).car))),
		);
		expect((await run()).settled).toBe(false);
		expect(process.exitCode).toBe(0);
	});

	it("uses the last block before a period end that falls between blocks", async () => {
		offset = 1n; // Boundary is 99, settlement is 147, with head exactly at settlement.
		head = 147n;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(Uint8Array.from((await packDirectory(fixture)).car))),
		);
		expect((await run()).settled).toBe(true);
	});

	it.each([
		"eth_getBlockByNumber",
		"settlement",
		"eth_call",
		"root",
		"resolver",
		"car",
		"missing-car",
		"start",
		"chain",
	])("fails %s errors without JSON and cleans temporary files", async (failure) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						failure === "car"
							? new Uint8Array([1])
							: Uint8Array.from((await packDirectory(fixture)).car),
					),
			),
		);
		fail = failure;
		if (failure === "root") root = `0x${"11".repeat(32)}`;
		if (failure === "resolver") resolver = zeroAddress;
		if (failure === "start") vi.stubEnv("CONSENSUS_START_BLOCK", "101");
		if (failure === "chain") chainId = 100;
		expect(
			await run(
				...(failure === "missing-car" ? ["--previousCar", join(fixture, "missing.car")] : []),
			),
		).toBeUndefined();
		expect(console.error).toHaveBeenCalledOnce();
		expect(process.exitCode).toBe(1);
	});

	it("requires ENS configuration before RPC", async () => {
		vi.stubEnv("REWARDS_ENS_NAME", undefined);
		await expect(run()).rejects.toThrow();
		expect(requests).toEqual([]);
	});

	it.each([
		"rewardPeriodStart",
		"rewardPeriodEnd",
		"totalRewards",
		"sentinelRewards",
		"minPayout",
		"kycThreshold",
		"out",
		"realityModuleAddress",
	])("rejects unsupported --%s before RPC", async (flag) => {
		await expect(run(`--${flag}=unused`)).rejects.toThrow(`Unknown option '--${flag}'`);
		expect(requests).toEqual([]);
	});
});
