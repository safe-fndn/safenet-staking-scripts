import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Address,
	createClient,
	custom,
	decodeFunctionData,
	encodeAbiParameters,
	encodeEventTopics,
	encodeFunctionResult,
	type Hex,
	toHex,
	zeroHash,
} from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REALITY_ETH_ERC20_ABI, REALITY_MODULE_ABI } from "../src/abi.js";
import { actionBundles } from "../src/distribution/actions.js";
import * as exporting from "../src/distribution/export.js";
import { buildQuestion, proposal, questionId } from "../src/distribution/transactions.js";
import { verifyProposal } from "../src/distribution/verify.js";
import type { Safenet } from "../src/safenet.js";
import { backoff } from "../src/utils/backoff.js";
import { CONFIG, CUMULATIVE_MERKLE_DROP, UPDATE } from "./harness/governance.js";
import { namedAddress } from "./harness/utils.js";

const PROPOSAL = proposal(UPDATE, CONFIG);
const QUESTION = buildQuestion(PROPOSAL.proposalId, [PROPOSAL.transaction.hash]);
const DIFFERENT = buildQuestion(PROPOSAL.proposalId, [zeroHash]);
const HEAD = 20n;
const FROM = 10n; // Ethereum block 10 is at t=120; consensus settlement block is unrelated.
const noBackoff = backoff({ delays: [] });
const ROOT = tmpdir();
let temporary: string;
let exported: exporting.Export;
let settlementTimestamp: bigint;
// The export is mocked here; tests/export.test.ts exercises the real pipeline and accounting.
const safenet = {} as Safenet;

beforeEach(async () => {
	settlementTimestamp = 120n;
	temporary = await mkdtemp(join(ROOT, "safenet-verify-test-"));
	vi.stubEnv("TMPDIR", temporary);
	vi.spyOn(exporting, "exportPackage").mockImplementation(async (_, __, dir) => {
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "latest.json"), "partial or completed export");
		exported = {
			stakingChainId: 1,
			blockNumber: HEAD - 1n,
			governance: CONFIG,
			previous: { cid: UPDATE.cid, merkleRoot: zeroHash, rewardsUntil: 0n },
			period: { fromTimestamp: 0n, toTimestamp: 60n },
			totalRewards: 10n,
			sentinelRewards: 2n,
			settlement: { boundaryBlock: 951n, settlementBlock: 999n, settlementTimestamp },
			payouts: {
				[namedAddress("staker")]: { stakeRewards: 7n, commission: 1n, sentinelRewards: 2n },
			},
			unpaid: 2n,
			forfeited: 2n,
			sanctionsRelease: "data-2026-10-26",
			additionalAmount: UPDATE.additionalAmount,
			merkleRoot: UPDATE.merkleRoot,
			newlyApproved: [namedAddress("staker")],
			cid: UPDATE.cid,
			car: new Uint8Array([1, 2, 3]),
			dir,
			proposal: PROPOSAL,
			bundles: actionBundles(PROPOSAL, CONFIG, 120n),
		};
		return exported;
	});
});
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await rm(temporary, { recursive: true, force: true });
});

const rawLog = (address: Address, topics: readonly Hex[], data: Hex, block: bigint) => ({
	address,
	topics,
	data,
	blockNumber: toHex(block),
	blockHash: toHex(block, { size: 32 }),
	transactionHash: zeroHash,
	transactionIndex: "0x0",
	logIndex: "0x0",
	removed: false,
});

const pair = (text = QUESTION, nonce = 0n, block = FROM) => [
	rawLog(
		CONFIG.module,
		encodeEventTopics({
			abi: REALITY_MODULE_ABI,
			eventName: "ProposalQuestionCreated",
			args: { questionId: questionId(text, CONFIG, nonce), proposalId: PROPOSAL.proposalId },
		}) as Hex[],
		"0x",
		block,
	),
	rawLog(
		CONFIG.oracle,
		encodeEventTopics({
			abi: REALITY_ETH_ERC20_ABI,
			eventName: "LogNewQuestion",
			args: {
				question_id: questionId(text, CONFIG, nonce),
				user: CONFIG.module,
				content_hash: zeroHash,
			},
		}) as Hex[],
		encodeAbiParameters(
			[
				{ type: "uint256" },
				{ type: "string" },
				{ type: "address" },
				{ type: "uint32" },
				{ type: "uint32" },
				{ type: "uint256" },
				{ type: "uint256" },
			],
			[CONFIG.templateId, text, CONFIG.arbitrator, Number(CONFIG.questionTimeout), 0, nonce, 1n],
		),
		block,
	),
];

const fakeChain = (
	logs: ReturnType<typeof pair> = [],
	{ executed = false, current = PROPOSAL.questionId, genesis = 0n } = {},
) => {
	const filters: { address: Address; topics: (Hex | null)[]; fromBlock: Hex; toBlock: Hex }[] = [];
	const client = createClient({
		transport: custom(
			{
				async request({ method, params }) {
					if (method === "eth_blockNumber") return toHex(HEAD);
					if (method === "eth_getBlockByNumber") {
						const [tag] = params as [string];
						const number = tag === "latest" ? HEAD : BigInt(tag);
						return { number: toHex(number), timestamp: toHex(genesis + number * 12n) };
					}
					if (method === "eth_getLogs") {
						const [filter] = params as [(typeof filters)[number]];
						filters.push(filter);
						return logs.filter(
							(log) =>
								log.address.toLowerCase() === filter.address.toLowerCase() &&
								BigInt(log.blockNumber) >= BigInt(filter.fromBlock) &&
								BigInt(log.blockNumber) <= BigInt(filter.toBlock) &&
								filter.topics.every((topic, i) => topic === null || topic === log.topics[i]),
						);
					}
					if (method === "eth_call") {
						const [{ data }, block] = params as [{ data: Hex }, Hex];
						expect(block).toBe(toHex(HEAD));
						const { functionName } = decodeFunctionData({ abi: REALITY_MODULE_ABI, data });
						if (functionName === "questionIds" || functionName === "executedProposalTransactions") {
							return encodeFunctionResult({
								abi: REALITY_MODULE_ABI,
								functionName,
								result: functionName === "questionIds" ? current : executed,
							} as never);
						}
					}
					throw new Error(`unexpected RPC ${method}`);
				},
			},
			{ retryCount: 0 },
		),
	});
	const config: exporting.ExportConfiguration = {
		stakingClient: client,
		stakingAddress: namedAddress("staking"),
		// The proposal scan must not use a configured staking indexing start block.
		stakingStartBlock: HEAD,
		delegateRegistryAddress: namedAddress("delegates"),
		sanctionsListAddress: namedAddress("sanctions"),
		sanctionsAddressRepo: "example/sanctions-address-lists",
		consensusClient: createClient({
			transport: custom({
				async request() {
					throw new Error("wrong chain");
				},
			}),
		}),
		consensusAddress: namedAddress("consensus"),
		sentinelOracleAddress: namedAddress("sentinel"),
		cumulativeMerkleDropAddress: CUMULATIVE_MERKLE_DROP,
		realityModuleAddress: CONFIG.module,
		rewardsEnsName: CONFIG.ensName,
	};
	return {
		config,
		filters,
		run: () => verifyProposal(safenet, config, { withBackoff: noBackoff }),
	};
};

const entry = (question = QUESTION, nonce = 0n) => ({
	questionId: questionId(question, CONFIG, nonce),
	question,
});

describe("verifyProposal", () => {
	it("reuses exportPackage and returns its in-memory summary without a deleted path", async () => {
		const chain = fakeChain();
		const result = await chain.run();
		const { dir, ...distribution } = exported;
		expect(exporting.exportPackage).toHaveBeenCalledExactlyOnceWith(safenet, chain.config, dir);
		expect(dir).toMatch(/safenet-verify-[^/]+\/package$/);
		expect(result).toEqual({
			distribution,
			onchain: { blockNumber: HEAD, matching: [], different: [] },
			outcome: "none yet",
		});
		expect(result.distribution).not.toHaveProperty("dir");
		await expect(readdir(dir)).rejects.toThrow("ENOENT");
		expect(await readdir(temporary)).toEqual([]);
	});

	it.each([false, true])("reports matching with executed=%s", async (executed) => {
		const result = await fakeChain(pair(), { executed }).run();
		expect(result.outcome).toBe("matching");
		expect(result.onchain.matching).toEqual([
			{ ...entry(), currentQuestionId: PROPOSAL.questionId, executed },
		]);
		expect(result.onchain.different).toEqual([]);
		expect(await readdir(temporary)).toEqual([]);
	});

	it("retains re-asked matches and the current question mapping", async () => {
		const current = questionId(QUESTION, CONFIG, 2n);
		const result = await fakeChain([...pair(), ...pair(QUESTION, 2n)], { current }).run();
		expect(result.outcome).toBe("matching");
		expect(result.onchain.matching).toEqual(
			[0n, 2n].map((nonce) => ({
				...entry(QUESTION, nonce),
				currentQuestionId: current,
				executed: false,
			})),
		);
	});

	it.each([
		false,
		true,
	])("fails any different question with matching=%s, retaining both lists", async (matching) => {
		const result = await fakeChain([...(matching ? pair() : []), ...pair(DIFFERENT)]).run();
		expect(result.outcome).toBe("different");
		expect(result.onchain.different).toEqual([entry(DIFFERENT)]);
		expect(result.onchain.matching).toEqual(
			matching ? [{ ...entry(), currentQuestionId: PROPOSAL.questionId, executed: false }] : [],
		);
		expect(await readdir(temporary)).toEqual([]);
	});

	it.each([
		120n,
		125n,
	])("scans inclusively from the Ethereum settlement boundary for t=%s", async (timestamp) => {
		settlementTimestamp = timestamp;
		const chain = fakeChain([...pair(DIFFERENT, 0n, FROM - 1n), ...pair()]);
		const result = await chain.run();
		expect(result.outcome).toBe("matching");
		expect(chain.filters[0]).toMatchObject({ fromBlock: toHex(FROM), toBlock: toHex(HEAD) });
		expect(result.onchain.different).toEqual([]);
	});

	it("cleans a partial export and propagates its error without starting lookup", async () => {
		const error = new Error("export failed");
		vi.mocked(exporting.exportPackage).mockImplementationOnce(async (_, __, dir) => {
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, ".lock"), "partial export");
			throw error;
		});
		const chain = fakeChain();
		await expect(chain.run()).rejects.toBe(error);
		expect(chain.filters).toEqual([]);
		expect(await readdir(temporary)).toEqual([]);
	});

	it("propagates lookup errors and removes the completed export", async () => {
		const [moduleLog] = pair(); // Missing oracle log must never become 'none yet'.
		await expect(fakeChain([moduleLog]).run()).rejects.toThrow("expected one LogNewQuestion");
		expect(await readdir(temporary)).toEqual([]);
	});

	it("propagates boundary lookup errors and cleans up", async () => {
		// The fake Ethereum head is at t=240, before this settlement.
		settlementTimestamp = 241n;
		await expect(fakeChain().run()).rejects.toThrow("timestamp 241 is after the latest block");
		expect(await readdir(temporary)).toEqual([]);
	});

	it("refuses a settlement before Ethereum genesis and cleans up", async () => {
		await expect(fakeChain([], { genesis: 121n }).run()).rejects.toThrow(
			"settlement timestamp 120 is before the Ethereum genesis block",
		);
		expect(await readdir(temporary)).toEqual([]);
	});
});
