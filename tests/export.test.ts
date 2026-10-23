import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Address,
	type Client,
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
	STAKING_ABI,
} from "../src/abi.js";
import {
	type ExportConfiguration,
	exportInputs,
	exportPackage,
} from "../src/distribution/export.js";
import { packDirectory } from "../src/distribution/ipfs.js";
import { kyc } from "../src/distribution/kyc.js";
import { ENS_REGISTRY } from "../src/distribution/previous.js";
import { encodeContenthash, zProposal } from "../src/distribution/transactions.js";
import { MerkleDb } from "../src/merkledb/index.js";
import { Safenet, SETTLEMENT_BLOCKS } from "../src/safenet.js";
import { canonicalJson } from "../src/utils/json.js";
import {
	AEGIS_REWARDS_START,
	AEGIS_VALIDATOR_REWARDS,
	AEGIS_VALIDATOR_REWARDS_DURATION,
	BETA_REWARDS_UNTIL,
	BETA_TOKEN_TOTAL,
	SENTINEL_REWARDS_PER_YEAR,
	SENTINEL_REWARDS_YEAR,
} from "../src/utils/sep.js";
import { CONFIG, CUMULATIVE_MERKLE_DROP, SAFE_TOKEN } from "./harness/governance.js";
import { attestedTransaction, sentinelRequest } from "./harness/presets.js";
import { createTestParameters, type Scenario } from "./harness/scenario.js";
import { emptyBlocks, namedAddress, parseSafe } from "./harness/utils.js";

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
const previousRewardsDb = async ({
	firstAegisPayout,
	kycApprovals = [],
}: {
	firstAegisPayout?: bigint;
	kycApprovals?: Address[];
} = {}) => {
	const root = await temporary();
	await writeFile(
		join(root, "latest.json"),
		`{"epoch":0,"merkleRoot":"${toHex(0, { size: 32 })}","tokenTotal":"0"}\n`,
	);
	const update = await new MerkleDb({ root }).distribute(
		{ fromTimestamp: BETA_REWARDS_UNTIL - TWO_WEEKS, toTimestamp: BETA_REWARDS_UNTIL },
		{ [namedAddress("carol")]: { amount: BETA_TOKEN_TOTAL, sentinelAmount: 0n } },
		0n,
		{ sanctions: [], kycApprovals },
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
	/**
	 * A mock staking chain that every other request goes to, with the staking contract's
	 * `SAFE_TOKEN()`, which `MockChain` does not model.
	 */
	inner?: Client;
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
	inner,
}: Chain) => {
	const blockTags: string[] = [];
	let resolverCalls = 0;
	const client = createClient({
		transport: custom({
			async request({ method, params }) {
				if (inner !== undefined && method !== "eth_call") {
					return inner.request({ method, params } as never);
				}
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
				if (inner !== undefined) {
					if (call(namedAddress("Staking"))) {
						const { functionName } = decodeFunctionData({ abi: STAKING_ABI, data });
						if (functionName === "SAFE_TOKEN") {
							return encodeFunctionResult({
								abi: STAKING_ABI,
								functionName: "SAFE_TOKEN",
								result: SAFE_TOKEN,
							});
						}
					}
					return inner.request({ method, params } as never);
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

// The end-to-end tests export the first Aegis period, derived from a previous rewards DB that ends
// with Beta. To span its two weeks in a few hundred blocks, consensus blocks are an hour apart and
// staking blocks a day apart, and both chains start an hour before Aegis, at `T`:
// - consensus slot k is block k + 1 at T + k hours, so the period starts with block 2, ends with
//   block 338 (T + 337 h), and settles at block 338 + 48 = 386 (T + 385 h);
// - staking slot k is block k + 1 at T + k days, and block 18 (T + 17 d) is past the settlement.
const HOUR = 60n * 60n;
const DAY = 24n * HOUR;
const T = AEGIS_REWARDS_START - HOUR;
const SETTLEMENT_TIMESTAMP = FIRST_AEGIS_PERIOD.toTimestamp + SETTLEMENT_BLOCKS * HOUR;

// alice and bob each self-stake 1M SAFE and sign the period's only transaction, so each staker earns
// half of the validator budget. sentinel1 and sentinel2 answer the period's only oracle request.
const SCENARIO: Scenario = {
	genesisTimestamp: T,
	staking: {
		blockTime: DAY,
		slots: [
			{
				events: [
					{ name: "ValidatorUpdated", validator: namedAddress("alice"), isRegistered: true },
					{ name: "ValidatorUpdated", validator: namedAddress("bob"), isRegistered: true },
					{
						name: "StakeIncreased",
						staker: namedAddress("aliceStaker"),
						validator: namedAddress("alice"),
						amount: parseSafe("1000000"),
					},
					{
						name: "StakeIncreased",
						staker: namedAddress("bobStaker"),
						validator: namedAddress("bob"),
						amount: parseSafe("1000000"),
					},
				],
			},
			// Past the settlement timestamp, as every indexer is updated to it.
			...emptyBlocks(17, { assertTimestamp: T + 17n * DAY }),
		],
	},
	consensus: {
		blockTime: HOUR,
		slots: [
			{
				events: [
					{ name: "KeyGenConfirmed", participant: namedAddress("alice") },
					{ name: "KeyGenConfirmed", participant: namedAddress("bob") },
				],
			},
			...emptyBlocks(1, { assertTimestamp: FIRST_AEGIS_PERIOD.fromTimestamp }),
			{
				assertTimestamp: FIRST_AEGIS_PERIOD.fromTimestamp + HOUR,
				events: [
					...attestedTransaction({ epoch: 1n, seed: "1", participants: ["alice", "bob"] }),
					...sentinelRequest({ seed: "1", reveals: ["sentinel1", "sentinel2"] }),
				],
			},
			...emptyBlocks(335, { assertTimestamp: FIRST_AEGIS_PERIOD.toTimestamp }),
			// Up to the period's settlement block.
			...emptyBlocks(Number(SETTLEMENT_BLOCKS), { assertTimestamp: SETTLEMENT_TIMESTAMP }),
		],
	},
};

const SANCTIONS = { accounts: [namedAddress("bobStaker")], release: "data-2026-10-12" };

/**
 * Runs an export on top of a previous rewards DB into a new directory, with a
 * fresh `Safenet` over `scenario`. The mock staking client is wrapped with the governance
 * contracts. The pinned sanctions are stubbed, so that the tests make no GitHub requests.
 */
const runExport = async (previous: Previous, scenario = SCENARIO) => {
	const parameters = createTestParameters(scenario);
	const { client: stakingClient } = fakeChain({
		contenthash: encodeContenthash(previous.cid),
		merkleRoot: previous.merkleRoot,
		inner: parameters.stakingClient,
	});
	const safenet = await Safenet.create({ ...parameters, stakingClient });
	vi.spyOn(safenet, "pinnedSanctionedAccounts").mockResolvedValue(SANCTIONS);
	const config: ExportConfiguration = {
		...parameters,
		stakingClient,
		previousCar: previous.previousCar,
		cumulativeMerkleDropAddress: CUMULATIVE_MERKLE_DROP,
		realityModuleAddress: CONFIG.module,
		rewardsEnsName: CONFIG.ensName,
	};
	const dir = join(await temporary(), "package");
	return exportPackage(safenet, config, dir);
};

describe("exportPackage", () => {
	it("builds a package on top of the previous rewards DB", async () => {
		const previous = await previousRewardsDb();
		const result = await runExport(previous);

		// The package on disk is the one that was packed, and every file is canonical JSON.
		const packed = await packDirectory(result.dir);
		expect(packed.cid.equals(result.cid)).toBe(true);
		expect(packed.car).toEqual(result.car);
		const tree = await readTree(result.dir);
		expect(Object.keys(tree)).toContain("latest.json");
		for (const contents of Object.values(tree)) {
			expect(canonicalJson(JSON.parse(contents))).toBe(contents);
		}

		// The validator budget is the Aegis share of two weeks, 5M / 26 ≈ 192,307.69 SAFE, as
		// nothing of it has been paid yet, and each staker earns half of it. Each sentinel earns
		// the prorated grant of 400,000 SAFE a year (52 weeks) for two weeks, ≈ 15,384.62 SAFE.
		// The withheld and the sanctioned rewards count towards `tokenTotal`, so the transfer
		// covers the whole budget and both grants.
		const totalRewards = (AEGIS_VALIDATOR_REWARDS * TWO_WEEKS) / AEGIS_VALIDATOR_REWARDS_DURATION;
		const sentinelRewards = (SENTINEL_REWARDS_PER_YEAR * TWO_WEEKS) / SENTINEL_REWARDS_YEAR;
		const split = { stakeRewards: 0n, commission: 0n, sentinelRewards: 0n };
		expect(result).toEqual({
			stakingChainId: 1,
			// The head of the mock staking chain, which serves the block number.
			blockNumber: 18n,
			governance: CONFIG,
			previous: {
				cid: previous.cid,
				merkleRoot: previous.merkleRoot,
				rewardsUntil: BETA_REWARDS_UNTIL,
			},
			period: FIRST_AEGIS_PERIOD,
			totalRewards,
			sentinelRewards,
			settlement: {
				boundaryBlock: 338n,
				settlementBlock: 386n,
				settlementTimestamp: SETTLEMENT_TIMESTAMP,
			},
			payouts: {
				[namedAddress("aliceStaker")]: { ...split, stakeRewards: totalRewards / 2n },
				[namedAddress("bobStaker")]: { ...split, stakeRewards: totalRewards / 2n },
				[namedAddress("sentinel1")]: { ...split, sentinelRewards },
				[namedAddress("sentinel2")]: { ...split, sentinelRewards },
			},
			unpaid: totalRewards % 2n,
			forfeited: 0n,
			sanctionsRelease: SANCTIONS.release,
			additionalAmount: totalRewards - (totalRewards % 2n) + 2n * sentinelRewards,
			merkleRoot: expect.stringMatching(/^0x[0-9a-f]{64}$/),
			newlyApproved: kyc().accounts,
			cid: packed.cid,
			car: packed.car,
			dir: result.dir,
			proposal: expect.anything(),
			bundles: expect.anything(),
		});

		// Every payout is at or above the 7,500 SAFE KYC threshold, and no recipient is approved, so
		// all of them are withheld in `kycAmount` rather than claimable, and none is in the tree.
		const entry = (account: string) => {
			const [path] = Object.keys(tree).filter((path) =>
				path.endsWith(`${account.toLowerCase()}.json`),
			);
			return JSON.parse(tree[path]);
		};
		for (const [account, amount] of [
			["aliceStaker", totalRewards / 2n],
			["sentinel1", sentinelRewards],
			["sentinel2", sentinelRewards],
		] as const) {
			expect(entry(namedAddress(account)), account).toMatchObject({
				cumulativeAmount: "0",
				kycAmount: `${amount}`,
				proof: null,
			});
		}

		// The proposal is about the package, and its bundles are created at the settlement.
		const proposal = zProposal.parse(JSON.parse(canonicalJson(result.proposal)));
		expect(proposal.proposalId).toBe(result.cid.toString());
		expect(Object.keys(result.bundles).sort()).toEqual(["answer", "execute", "propose"]);
		for (const bundle of Object.values(result.bundles)) {
			expect(bundle.createdAt).toBe(Number(SETTLEMENT_TIMESTAMP) * 1000);
		}
		expect(await readdir(exportTmpdir)).toEqual([]);
	});

	it("is deterministic", async () => {
		const previous = await previousRewardsDb();
		const first = await runExport(previous);
		const second = await runExport(previous);

		expect(second.dir).not.toBe(first.dir);
		expect(second.cid.equals(first.cid)).toBe(true);
		expect(second.car).toEqual(first.car);
		expect(await readTree(second.dir)).toEqual(await readTree(first.dir));
		expect(canonicalJson(second.proposal)).toBe(canonicalJson(first.proposal));
		expect(canonicalJson(second.bundles)).toBe(canonicalJson(first.bundles));
	});

	it.each([
		// The consensus chain stops at block 328, 10 blocks before the period ends with block 338.
		["has not ended", 325, `timestamp ${FIRST_AEGIS_PERIOD.toTimestamp} is after the latest block`],
		// The consensus chain stops at block 348, 38 blocks before the settlement block 386.
		["has not settled", 345, "settlement block 386 does not exist yet"],
	] as const)("refuses a period that %s", async (_, blocks, cause) => {
		const previous = await previousRewardsDb();
		const [keyGen, start, transactions] = SCENARIO.consensus.slots;
		const scenario: Scenario = {
			...SCENARIO,
			consensus: {
				...SCENARIO.consensus,
				slots: [keyGen, start, transactions, ...emptyBlocks(blocks)],
			},
		};

		await expect(runExport(previous, scenario)).rejects.toThrow(
			`period 2026-10-13T00:00:00.000Z → 2026-10-27T00:00:00.000Z after rewards DB ` +
				`${previous.cid} has not settled yet (${cause})`,
		);
		expect(await readdir(exportTmpdir)).toEqual([]);
	});

	it("refuses a previously approved account that is missing from the KYC file", async () => {
		const previous = await previousRewardsDb({ kycApprovals: [namedAddress("dave")] });

		await expect(runExport(previous)).rejects.toThrow(
			`KYC-approved account ${namedAddress("dave")} is missing from the approvals`,
		);
		expect(await readdir(exportTmpdir)).toEqual([]);
	});
});
