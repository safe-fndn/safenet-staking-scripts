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
	type ExportPeriod,
	exportInputs,
	exportPackage,
} from "../src/distribution/export.js";
import { IPFS_PARAMETERS, packDirectory } from "../src/distribution/ipfs.js";
import { kyc } from "../src/distribution/kyc.js";
import { zManifest } from "../src/distribution/manifest.js";
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
const PERIOD = { fromTimestamp: AEGIS_REWARDS_START, toTimestamp: AEGIS_REWARDS_START + TWO_WEEKS };

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
 * `latest.json`, up to `BETA_REWARDS_UNTIL`, with the Beta `tokenTotal`. It is packed into a CAR
 * file.
 */
const previousRewardsDb = async () => {
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
	const { cid, car } = await packDirectory(root);
	const previousCar = join(await temporary(), "previous.car");
	await writeFile(previousCar, car);
	return { cid, merkleRoot: update.merkleRoot, previousCar, root };
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

const run = async (
	previous: Previous,
	{
		period = { period: PERIOD },
		chain = {},
	}: { period?: ExportPeriod; chain?: Partial<Chain> } = {},
) => {
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
		period,
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

		// The budget is measured from the start of Aegis, and nothing of it has been paid yet,
		// so the first period gets exactly its prorated share. The sentinel grant is prorated too.
		expect(await result).toEqual({
			stakingChainId: 1,
			blockNumber: BLOCK_NUMBER,
			governance: CONFIG,
			previous: {
				cid: previous.cid,
				merkleRoot: previous.merkleRoot,
				rewardsUntil: BETA_REWARDS_UNTIL,
			},
			totalRewards: (AEGIS_VALIDATOR_REWARDS * TWO_WEEKS) / AEGIS_VALIDATOR_REWARDS_DURATION,
			sentinelRewards: (SENTINEL_REWARDS_PER_YEAR * TWO_WEEKS) / SENTINEL_REWARDS_YEAR,
		});
		// The 11 governance reads and the 3 reads of the previous rewards DB.
		expect(blockTags).toEqual(Array(14).fill(toHex(BLOCK_NUMBER)));
		expect(await readTree(dir)).toEqual(await readTree(previous.root));
		expect(await readdir(exportTmpdir)).toEqual([]);
	});

	it("uses the amount overrides", async () => {
		const previous = await previousRewardsDb();
		const { result } = await run(previous, {
			period: {
				period: PERIOD,
				totalRewards: parseSafe("1000"),
				sentinelRewards: parseSafe("10"),
			},
		});

		expect(await result).toMatchObject({
			totalRewards: parseSafe("1000"),
			sentinelRewards: parseSafe("10"),
		});
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

	it.each([
		// Contiguous with Beta, but the week between Beta and Aegis is never paid.
		["the gap week", { fromTimestamp: BETA_REWARDS_UNTIL, toTimestamp: AEGIS_REWARDS_START }],
		[
			"a later start",
			{ fromTimestamp: PERIOD.toTimestamp, toTimestamp: PERIOD.toTimestamp + TWO_WEEKS },
		],
		["an empty period", { fromTimestamp: AEGIS_REWARDS_START, toTimestamp: AEGIS_REWARDS_START }],
	])("refuses a period that does not follow the previous rewards DB: %s", async (_, period) => {
		const previous = await previousRewardsDb();
		const { result, dir } = await run(previous, { period: { period } });

		await expect(result).rejects.toThrow(
			`period [${period.fromTimestamp}, ${period.toTimestamp}] does not follow rewards DB ` +
				`${previous.cid}, which ends at ${BETA_REWARDS_UNTIL}`,
		);
		await expect(readdir(dir)).rejects.toThrow("ENOENT");
		expect(await readdir(exportTmpdir)).toEqual([]);
	});
});

// The harness chains start at t=0, so the end-to-end tests distribute the period [60, 120] on top
// of a previous rewards DB ending at 60. The period ends with consensus block 25 (t=120) and
// settles at block 25 + 48 = 73 (t=360).
const HARNESS_PERIOD = { fromTimestamp: 60n, toTimestamp: 120n };
const HARNESS_PREVIOUS_PERIOD = { fromTimestamp: 0n, toTimestamp: 60n };

// alice and bob each self-stake 1M SAFE and sign the period's only transaction, so each staker earns
// half of the 20,000 SAFE budget, which is above the KYC threshold. sentinel1 and sentinel2 answer
// the period's only oracle request.
const SCENARIO: Scenario = {
	staking: {
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
			// Up to the settlement timestamp, as every indexer is updated to it.
			...emptyBlocks(30, { assertTimestamp: 360n }),
		],
	},
	consensus: {
		slots: [
			{
				events: [
					{ name: "KeyGenConfirmed", participant: namedAddress("alice") },
					{ name: "KeyGenConfirmed", participant: namedAddress("bob") },
				],
			},
			...emptyBlocks(12, { assertTimestamp: 60n }),
			{
				assertTimestamp: 65n,
				events: [
					...attestedTransaction({ epoch: 1n, seed: "1", participants: ["alice", "bob"] }),
					...sentinelRequest({ seed: "1", reveals: ["sentinel1", "sentinel2"] }),
				],
			},
			...emptyBlocks(11, { assertTimestamp: 120n }),
			// Up to the period's settlement block.
			...emptyBlocks(Number(SETTLEMENT_BLOCKS), { assertTimestamp: 360n }),
		],
	},
};

const SANCTIONS = {
	accounts: [namedAddress("bobStaker")],
	offchain: {
		release: "data-2026-10-26",
		sha256: {
			"ch-seco": "01".repeat(32),
			eu: "02".repeat(32),
			uk: "03".repeat(32),
			un: "04".repeat(32),
			"us-ofac": "05".repeat(32),
		},
	},
};

const GENERATOR = {
	commit: "0123456789abcdef0123456789abcdef01234567",
	repository: "https://github.com/safe-fndn/safenet-staking-scripts",
};

/**
 * A previous rewards DB, distributed once on top of an empty `latest.json` for the period
 * before `HARNESS_PERIOD`, packed into a CAR file.
 */
const harnessRewardsDb = async ({ kycApprovals = [] as Address[] } = {}) => {
	const root = await temporary();
	await writeFile(
		join(root, "latest.json"),
		`{"epoch":0,"merkleRoot":"${toHex(0, { size: 32 })}","tokenTotal":"0"}\n`,
	);
	const update = await new MerkleDb({ root }).distribute(
		HARNESS_PREVIOUS_PERIOD,
		{ [namedAddress("carol")]: { amount: parseSafe("100"), sentinelAmount: 0n } },
		0n,
		{ sanctions: [], kycApprovals },
	);
	if (update === null) {
		throw new Error("fixture distribution was rejected");
	}
	const { cid, car } = await packDirectory(root);
	const previousCar = join(await temporary(), "previous.car");
	await writeFile(previousCar, car);
	return { cid, merkleRoot: update.merkleRoot, previousCar, root };
};

/**
 * Runs an export of `HARNESS_PERIOD` on top of a previous rewards DB into a new directory, with a
 * fresh `Safenet` over the scenario. The mock staking client is wrapped with the governance
 * contracts. The pinned sanctions are stubbed, because the harness chains start in 1970, long
 * before any sanctions snapshot.
 */
const runExport = async (previous: Previous) => {
	const parameters = createTestParameters(SCENARIO);
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
	return exportPackage(
		safenet,
		config,
		{
			period: HARNESS_PERIOD,
			totalRewards: parseSafe("20000"),
			minPayout: parseSafe("1"),
			generator: GENERATOR,
		},
		dir,
	);
};

describe("exportPackage", () => {
	it("builds a package on top of the previous rewards DB", async () => {
		const previous = await harnessRewardsDb();
		const result = await runExport(previous);

		// The package on disk is the one that was packed, and every file is canonical JSON.
		const packed = await packDirectory(result.dir);
		expect(packed.cid.equals(result.cid)).toBe(true);
		expect(packed.car).toEqual(result.car);
		const tree = await readTree(result.dir);
		for (const contents of Object.values(tree)) {
			expect(canonicalJson(JSON.parse(contents))).toBe(contents);
		}

		// The manifest on disk parses and describes the export.
		const manifest = zManifest.parse(JSON.parse(tree["manifest.json"]));
		expect(canonicalJson(manifest)).toBe(canonicalJson(result.manifest));
		// Each staker earns half of the budget, and each sentinel the prorated grant of 400,000
		// SAFE a year for 60 seconds. The withheld and the sanctioned stake rewards both count
		// towards `tokenTotal`, so the transfer covers all 20,000 SAFE.
		const sentinelRewards = (SENTINEL_REWARDS_PER_YEAR * 60n) / SENTINEL_REWARDS_YEAR;
		expect(result.manifest).toEqual({
			allocations: { forfeited: 0n, unpaid: 0n },
			chains: {
				consensus: {
					boundaryBlock: 25n,
					chainId: 100,
					contracts: {
						consensus: namedAddress("Consensus"),
						sentinelOracle: namedAddress("SentinelOracle"),
					},
					settlementBlock: 73n,
				},
				staking: {
					boundaryBlock: 11n,
					chainId: 1,
					contracts: {
						delegateRegistry: namedAddress("DelegateRegistry"),
						sanctionsList: namedAddress("SanctionsList"),
						staking: namedAddress("Staking"),
					},
				},
			},
			distribution: {
				additionalAmount: parseSafe("20000") + 2n * sentinelRewards,
				cumulativeMerkleDrop: CUMULATIVE_MERKLE_DROP,
				merkleRoot: expect.stringMatching(/^0x[0-9a-f]{64}$/),
				safeToken: SAFE_TOKEN,
				tokenTotal: parseSafe("20100") + 2n * sentinelRewards,
			},
			generator: GENERATOR,
			governance: CONFIG,
			ipfs: IPFS_PARAMETERS,
			kyc: { newlyApproved: kyc().accounts, threshold: kyc().threshold },
			parameters: {
				minPayout: parseSafe("1"),
				sentinelRewards,
				totalRewards: parseSafe("20000"),
			},
			period: { ...HARNESS_PERIOD, settlementTimestamp: 360n },
			previous: {
				cid: previous.cid.toString(),
				merkleRoot: previous.merkleRoot,
				rewardsUntil: 60n,
			},
			sanctions: {
				offchain: { ...SANCTIONS.offchain, repository: "safe-fndn/sanctions-address-lists" },
			},
			version: 1,
		});

		// aliceStaker is above the KYC threshold and not approved, and bobStaker is sanctioned.
		expect(result.allocations).toEqual(
			[
				{
					account: namedAddress("aliceStaker"),
					status: "kyc-withheld",
					stakeRewards: parseSafe("10000"),
				},
				{
					account: namedAddress("bobStaker"),
					status: "sanctioned",
					stakeRewards: parseSafe("10000"),
				},
				{ account: namedAddress("sentinel1"), status: "paid", sentinelRewards },
				{ account: namedAddress("sentinel2"), status: "paid", sentinelRewards },
			]
				.map((allocation) => ({
					commission: 0n,
					sentinelRewards: 0n,
					stakeRewards: 0n,
					...allocation,
				}))
				.sort((a, b) => (a.account.toLowerCase() < b.account.toLowerCase() ? -1 : 1)),
		);

		// The proposal is about the package, and its bundles are created at the settlement.
		expect(zProposal.parse(JSON.parse(canonicalJson(result.proposal))).proposalId).toBe(
			result.cid.toString(),
		);
		expect(result.bundles.propose.createdAt).toBe(360_000);
		expect(Object.keys(result.bundles).sort()).toEqual(["answer", "execute", "propose"]);
		expect(await readdir(exportTmpdir)).toEqual([]);
	});

	it("is deterministic", async () => {
		const previous = await harnessRewardsDb();
		const first = await runExport(previous);
		const second = await runExport(previous);

		expect(second.dir).not.toBe(first.dir);
		expect(second.cid.equals(first.cid)).toBe(true);
		expect(second.car).toEqual(first.car);
		expect(await readTree(second.dir)).toEqual(await readTree(first.dir));
		expect(canonicalJson(second.proposal)).toBe(canonicalJson(first.proposal));
		expect(canonicalJson(second.bundles)).toBe(canonicalJson(first.bundles));
	});

	it("refuses a previously approved account that is missing from the KYC file", async () => {
		const previous = await harnessRewardsDb({ kycApprovals: [namedAddress("dave")] });

		await expect(runExport(previous)).rejects.toThrow(
			`KYC-approved account ${namedAddress("dave")} is missing from the approvals`,
		);
	});
});
