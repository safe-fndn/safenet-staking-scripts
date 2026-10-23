import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Address,
	createClient,
	custom,
	decodeFunctionData,
	encodeFunctionResult,
	type Hex,
	toHex,
} from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CUMULATIVE_MERKLE_DROP_ABI,
	ENS_REGISTRY_ABI,
	ENS_RESOLVER_ABI,
	REALITY_ETH_ERC20_ABI,
	REALITY_MODULE_ABI,
} from "../src/abi.js";
import { exportInputs } from "../src/distribution/export.js";
import { packDirectory } from "../src/distribution/ipfs.js";
import { ENS_REGISTRY } from "../src/distribution/previous.js";
import { encodeContenthash } from "../src/distribution/transactions.js";
import { MerkleDb } from "../src/merkledb/index.js";
import {
	AEGIS_REWARDS_START,
	AEGIS_VALIDATOR_REWARDS,
	AEGIS_VALIDATOR_REWARDS_DURATION,
	BETA_REWARDS_UNTIL,
	BETA_TOKEN_TOTAL,
	SENTINEL_REWARDS_PER_YEAR,
	SENTINEL_REWARDS_YEAR,
} from "../src/utils/sep.js";
import { CONFIG, CUMULATIVE_MERKLE_DROP } from "./harness/governance.js";
import { namedAddress, parseSafe } from "./harness/utils.js";

const TWO_WEEKS = 14n * 24n * 60n * 60n;
const BLOCK_NUMBER = 26300000n;

// The first Aegis period, which follows a previous rewards DB ending with Beta.
const FIRST_AEGIS_PERIOD = {
	fromTimestamp: AEGIS_REWARDS_START,
	toTimestamp: AEGIS_REWARDS_START + TWO_WEEKS,
};

// Read before `TMPDIR` is stubbed below.
const TMPDIR = tmpdir();
const temporaries: string[] = [];
const temporary = async (): Promise<string> => {
	const dir = await mkdtemp(join(TMPDIR, "safenet-export-test-"));
	temporaries.push(dir);
	return dir;
};

// Every temporary directory the export creates lands in its own `TMPDIR`, so that the tests can
// check that it is removed.
let exportTmpdir: string;
beforeEach(async () => {
	exportTmpdir = await temporary();
	vi.stubEnv("TMPDIR", exportTmpdir);
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

/**
 * A previous rewards DB in the state at the end of Beta: distributed once on top of an empty
 * `latest.json`, up to `BETA_REWARDS_UNTIL`, with the Beta `tokenTotal`. With `firstAegisPayout`,
 * it is then also distributed for the first Aegis period, paying that amount. It is packed into a
 * CAR file.
 */
const previousRewardsDb = async ({ firstAegisPayout }: { firstAegisPayout?: bigint } = {}) => {
	const root = await temporary();
	await writeFile(
		join(root, "latest.json"),
		`{"epoch":0,"merkleRoot":"${toHex(0, { size: 32 })}","tokenTotal":"0"}\n`,
	);
	const update = await new MerkleDb({ root }).distribute(
		{ fromTimestamp: BETA_REWARDS_UNTIL - TWO_WEEKS, toTimestamp: BETA_REWARDS_UNTIL },
		{ [namedAddress("carol")]: { amount: BETA_TOKEN_TOTAL, sentinelAmount: 0n } },
		0n,
		{ sanctions: [], kycApprovals: [] },
	);
	if (update === null) {
		throw new Error("fixture distribution was rejected");
	}
	const latest =
		firstAegisPayout === undefined
			? update
			: await new MerkleDb({ root }).distribute(
					FIRST_AEGIS_PERIOD,
					{ [namedAddress("carol")]: { amount: firstAegisPayout, sentinelAmount: 0n } },
					0n,
					{ sanctions: [], kycApprovals: [] },
				);
	if (latest === null) {
		throw new Error("fixture distribution was rejected");
	}
	const { cid, car } = await packDirectory(root);
	const previousCar = join(await temporary(), "previous.car");
	await writeFile(previousCar, car);
	return { cid, merkleRoot: latest.merkleRoot, previousCar, root };
};

type Chain = {
	chainId?: number;
	contenthash: Hex;
	merkleRoot: Hex;
	/** The resolvers the ENS registry returns, one per call, repeating the last one. */
	resolvers?: Address[];
};

/**
 * A fake mainnet serving the governance contracts, ENS and the Cumulative Merkle Drop with the
 * `CONFIG` vector, recording the block tag of every call. Every resolver it returns serves
 * `contenthash`.
 */
const fakeChain = ({
	chainId = 1,
	contenthash,
	merkleRoot,
	resolvers = [CONFIG.ensResolver],
}: Chain) => {
	const blockTags: string[] = [];
	let resolverCalls = 0;
	const client = createClient({
		transport: custom({
			async request({ method, params }) {
				if (method === "eth_chainId") {
					return toHex(chainId);
				}
				if (method === "eth_blockNumber") {
					return toHex(BLOCK_NUMBER);
				}
				if (method !== "eth_call") {
					throw new Error(`unsupported JSON-RPC method "${method}"`);
				}
				const [{ to, data }, blockTag] = params as [{ to: Address; data: Hex }, string];
				blockTags.push(blockTag);
				const call = (address: Address) => to.toLowerCase() === address.toLowerCase();
				if (call(CONFIG.module)) {
					const { functionName } = decodeFunctionData({ abi: REALITY_MODULE_ABI, data });
					const results: Record<string, unknown> = {
						avatar: CONFIG.avatar,
						target: CONFIG.avatar,
						oracle: CONFIG.oracle,
						template: CONFIG.templateId,
						questionArbitrator: CONFIG.arbitrator,
						minimumBond: CONFIG.minimumBond,
						questionTimeout: Number(CONFIG.questionTimeout),
						questionCooldown: Number(CONFIG.questionCooldown),
						answerExpiration: Number(CONFIG.answerExpiration),
					};
					return encodeFunctionResult({
						abi: REALITY_MODULE_ABI,
						functionName,
						result: results[functionName],
					} as never);
				}
				if (call(CONFIG.oracle)) {
					return encodeFunctionResult({
						abi: REALITY_ETH_ERC20_ABI,
						functionName: "token",
						result: CONFIG.bondToken,
					});
				}
				if (call(ENS_REGISTRY)) {
					const resolver = resolvers[Math.min(resolverCalls++, resolvers.length - 1)];
					return encodeFunctionResult({
						abi: ENS_REGISTRY_ABI,
						functionName: "resolver",
						result: resolver,
					});
				}
				if (resolvers.some(call)) {
					return encodeFunctionResult({
						abi: ENS_RESOLVER_ABI,
						functionName: "contenthash",
						result: contenthash,
					});
				}
				if (call(CUMULATIVE_MERKLE_DROP)) {
					return encodeFunctionResult({
						abi: CUMULATIVE_MERKLE_DROP_ABI,
						functionName: "merkleRoot",
						result: merkleRoot,
					});
				}
				throw new Error(`unexpected call to ${to}`);
			},
		}),
	});
	return { client, blockTags };
};

type Previous = Awaited<ReturnType<typeof previousRewardsDb>>;

const run = async (previous: Previous, { chain = {} }: { chain?: Partial<Chain> } = {}) => {
	const fake = fakeChain({
		contenthash: encodeContenthash(previous.cid),
		merkleRoot: previous.merkleRoot,
		...chain,
	});
	const dir = join(await temporary(), "package");
	const result = exportInputs(
		{
			stakingClient: fake.client,
			previousCar: previous.previousCar,
			cumulativeMerkleDropAddress: CUMULATIVE_MERKLE_DROP,
			realityModuleAddress: CONFIG.module,
			rewardsEnsName: CONFIG.ensName,
		},
		dir,
	);
	return { result, dir, blockTags: fake.blockTags };
};

/** Every file under `dir` and its contents. */
const readTree = async (dir: string): Promise<Record<string, string>> => {
	const tree: Record<string, string> = {};
	for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
		if (entry.isFile()) {
			const path = join(entry.parentPath, entry.name);
			tree[path.slice(dir.length + 1)] = await readFile(path, "utf8");
		}
	}
	return tree;
};

describe("exportInputs", () => {
	it("reads the inputs at one block and copies the previous rewards DB", async () => {
		const previous = await previousRewardsDb();
		const { result, dir, blockTags } = await run(previous);

		// The period skips the week between Beta and Aegis, and is the first Aegis period. The
		// budget is measured from the start of Aegis, and nothing of it has been paid yet, so the
		// first period gets exactly its prorated share. The sentinel grant is prorated too.
		expect(await result).toEqual({
			stakingChainId: 1,
			blockNumber: BLOCK_NUMBER,
			governance: CONFIG,
			previous: {
				cid: previous.cid,
				merkleRoot: previous.merkleRoot,
				rewardsUntil: BETA_REWARDS_UNTIL,
			},
			period: FIRST_AEGIS_PERIOD,
			totalRewards: (AEGIS_VALIDATOR_REWARDS * TWO_WEEKS) / AEGIS_VALIDATOR_REWARDS_DURATION,
			sentinelRewards: (SENTINEL_REWARDS_PER_YEAR * TWO_WEEKS) / SENTINEL_REWARDS_YEAR,
		});
		// The 11 governance reads and the 3 reads of the previous rewards DB.
		expect(blockTags).toEqual(Array(14).fill(toHex(BLOCK_NUMBER)));
		expect(await readTree(dir)).toEqual(await readTree(previous.root));
		expect(await readdir(exportTmpdir)).toEqual([]);
	});

	it("refuses a staking chain that is not the governance chain", async () => {
		const previous = await previousRewardsDb();
		const { result, blockTags } = await run(previous, { chain: { chainId: 100 } });

		await expect(result).rejects.toThrow("staking chain 100 is not the governance chain");
		expect(blockTags).toEqual([]);
	});

	it("refuses a previous rewards DB whose root differs from the drop's", async () => {
		const previous = await previousRewardsDb();
		const onchain = toHex(0x42, { size: 32 });
		const { result, dir } = await run(previous, { chain: { merkleRoot: onchain } });

		await expect(result).rejects.toThrow(
			`but CumulativeMerkleDrop ${CUMULATIVE_MERKLE_DROP} has Merkle root ${onchain}`,
		);
		await expect(readdir(dir)).rejects.toThrow("ENOENT");
		expect(await readdir(exportTmpdir)).toEqual([]);
	});

	it("refuses ENS resolvers that differ between the two reads", async () => {
		// At one block both reads return the same resolver, so only an inconsistent node can
		// provoke this.
		const previous = await previousRewardsDb();
		const other = namedAddress("resolver");
		const { result } = await run(previous, {
			chain: { resolvers: [CONFIG.ensResolver, other] },
		});

		await expect(result).rejects.toThrow(`ENS resolver ${other} != ${CONFIG.ensResolver}`);
		expect(await readdir(exportTmpdir)).toEqual([]);
	});

	it("derives the two weeks after a previous Aegis rewards DB", async () => {
		// The first Aegis period paid 5 SAFE less than its share, which the next period catches up.
		const firstShare = (AEGIS_VALIDATOR_REWARDS * TWO_WEEKS) / AEGIS_VALIDATOR_REWARDS_DURATION;
		const previous = await previousRewardsDb({ firstAegisPayout: firstShare - parseSafe("5") });
		const { result, dir } = await run(previous);

		// The budget of the first four weeks of Aegis, less what the first two paid.
		const inputs = await result;
		expect(inputs.previous.rewardsUntil).toBe(FIRST_AEGIS_PERIOD.toTimestamp);
		expect(inputs.period).toEqual({
			fromTimestamp: FIRST_AEGIS_PERIOD.toTimestamp,
			toTimestamp: FIRST_AEGIS_PERIOD.toTimestamp + TWO_WEEKS,
		});
		expect(inputs.totalRewards).toBe(
			(AEGIS_VALIDATOR_REWARDS * 2n * TWO_WEEKS) / AEGIS_VALIDATOR_REWARDS_DURATION -
				firstShare +
				parseSafe("5"),
		);
		expect(inputs.sentinelRewards).toBe(
			(SENTINEL_REWARDS_PER_YEAR * TWO_WEEKS) / SENTINEL_REWARDS_YEAR,
		);
		expect(await readTree(dir)).toEqual(await readTree(previous.root));
		expect(await readdir(exportTmpdir)).toEqual([]);
	});
});
