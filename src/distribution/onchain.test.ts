import {
	type Address,
	createClient,
	custom,
	decodeFunctionData,
	encodeAbiParameters,
	encodeEventTopics,
	encodeFunctionResult,
	type Hex,
	keccak256,
	toHex,
	zeroHash,
} from "viem";
import { describe, expect, it } from "vitest";
import { CONFIG, UPDATE } from "../../tests/harness/governance.js";
import { namedAddress } from "../../tests/harness/utils.js";
import { REALITY_ETH_ERC20_ABI, REALITY_MODULE_ABI } from "../abi.js";
import { backoff } from "../utils/backoff.js";
import { findProposal } from "./onchain.js";
import { buildQuestion, proposal, questionId } from "./transactions.js";

const PROPOSAL = proposal(UPDATE, CONFIG);
const QUESTION = buildQuestion(PROPOSAL.proposalId, [PROPOSAL.transaction.hash]);
const FROM = 100n;
const HEAD = 200n;
const fastBackoff = backoff({ delays: [0, 0] });
const SETTINGS = { module: CONFIG.module, oracle: CONFIG.oracle, fromBlock: FROM };

type Log = {
	address: Address;
	topics: readonly Hex[];
	data: Hex;
	blockNumber: Hex;
	blockHash: Hex;
	transactionHash: Hex;
	transactionIndex: Hex;
	logIndex: Hex;
	removed: boolean;
};

const log = (address: Address, topics: readonly Hex[], data: Hex, block: bigint): Log => ({
	address: address.toLowerCase() as Address,
	topics,
	data,
	blockNumber: toHex(block),
	blockHash: toHex(block, { size: 32 }),
	transactionHash: toHex(block + 1n, { size: 32 }),
	transactionIndex: "0x0",
	logIndex: "0x0",
	removed: false,
});

const moduleLog = (id: Hex, block = FROM, cid = PROPOSAL.proposalId, address = CONFIG.module) =>
	log(
		address,
		encodeEventTopics({
			abi: REALITY_MODULE_ABI,
			eventName: "ProposalQuestionCreated",
			args: { questionId: id, proposalId: cid },
		}) as Hex[],
		"0x",
		block,
	);

const oracleLog = (text = QUESTION, nonce = 0n, block = FROM, address = CONFIG.oracle) => {
	const id = questionId(text, CONFIG, nonce);
	return log(
		address,
		encodeEventTopics({
			abi: REALITY_ETH_ERC20_ABI,
			eventName: "LogNewQuestion",
			args: { question_id: id, user: CONFIG.module, content_hash: zeroHash },
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
	);
};

const pair = (text = QUESTION, nonce = 0n, block = FROM) => [
	moduleLog(questionId(text, CONFIG, nonce), block),
	oracleLog(text, nonce, block),
];

/** Filters raw logs as an RPC node would, and records every requested bound and state call. */
const fakeChain = (
	logs: Log[] = [],
	{ current = PROPOSAL.questionId, executed = false, failMethod = "" } = {},
) => {
	const filters: {
		address: Address;
		topics: (Hex | Hex[] | null)[];
		fromBlock: Hex;
		toBlock: Hex;
	}[] = [];
	const calls: { functionName: string; args: readonly unknown[]; blockTag: string }[] = [];
	let headRequests = 0;
	let failures = 0;
	const client = createClient({
		transport: custom(
			{
				async request({ method, params }) {
					if (method === failMethod && failures++ < 2) throw new Error("flaky RPC");
					if (method === "eth_blockNumber") {
						return toHex(HEAD + BigInt(headRequests++));
					}
					if (method === "eth_getLogs") {
						const [filter] = params as [(typeof filters)[number]];
						filters.push(filter);
						return logs.filter(
							(entry) =>
								entry.address.toLowerCase() === filter.address.toLowerCase() &&
								BigInt(entry.blockNumber) >= BigInt(filter.fromBlock) &&
								BigInt(entry.blockNumber) <= BigInt(filter.toBlock) &&
								filter.topics.every((topic, i) =>
									topic === null
										? true
										: (Array.isArray(topic) ? topic : [topic]).includes(entry.topics[i]),
								),
						);
					}
					if (method === "eth_call") {
						const [{ to, data }, blockTag] = params as [{ to: Address; data: Hex }, string];
						expect(to.toLowerCase()).toBe(CONFIG.module.toLowerCase());
						const { functionName, args } = decodeFunctionData({ abi: REALITY_MODULE_ABI, data });
						calls.push({ functionName, args: args ?? [], blockTag });
						if (functionName === "questionIds") {
							return encodeFunctionResult({
								abi: REALITY_MODULE_ABI,
								functionName,
								result: current,
							});
						}
						if (functionName === "executedProposalTransactions") {
							return encodeFunctionResult({
								abi: REALITY_MODULE_ABI,
								functionName,
								result: executed,
							});
						}
					}
					throw new Error(`unexpected RPC ${method}`);
				},
			},
			{ retryCount: 0 },
		),
	});
	return { client, filters, calls, headRequests: () => headRequests, failures: () => failures };
};

const lookup = (chain: ReturnType<typeof fakeChain>) =>
	findProposal(chain.client, SETTINGS, PROPOSAL, { withBackoff: fastBackoff });
const entry = (text = QUESTION, nonce = 0n) => ({
	questionId: questionId(text, CONFIG, nonce),
	question: text,
});

describe("findProposal", () => {
	it("returns no proposal without logs and filters the CID from the inclusive start", async () => {
		const chain = fakeChain();
		expect(await lookup(chain)).toEqual({ blockNumber: HEAD, matching: [], different: [] });
		expect(chain.calls).toEqual([]);
		expect(chain.filters).toEqual([
			{
				address: CONFIG.module,
				topics: encodeEventTopics({
					abi: REALITY_MODULE_ABI,
					eventName: "ProposalQuestionCreated",
					args: { proposalId: PROPOSAL.proposalId },
				}),
				fromBlock: toHex(FROM),
				toBlock: toHex(HEAD),
			},
		]);
	});

	it.each([
		false,
		true,
	])("reads matching current question and executed=%s using question-text hash", async (executed) => {
		const chain = fakeChain(pair(), { executed });
		expect(await lookup(chain)).toEqual({
			blockNumber: HEAD,
			matching: [{ ...entry(), currentQuestionId: PROPOSAL.questionId, executed }],
			different: [],
		});
		const hash = keccak256(toHex(QUESTION));
		expect(chain.calls).toEqual([
			{ functionName: "questionIds", args: [hash], blockTag: toHex(HEAD) },
			{
				functionName: "executedProposalTransactions",
				args: [hash, PROPOSAL.transaction.hash],
				blockTag: toHex(HEAD),
			},
		]);
	});

	it("keeps different questions alone and alongside matching questions", async () => {
		const different = buildQuestion(PROPOSAL.proposalId, [zeroHash]);
		for (const matching of [[], pair()]) {
			const chain = fakeChain([
				...matching,
				...pair(different),
				...pair(different, 1n),
				...pair(`${QUESTION} `),
				...pair(QUESTION.toUpperCase()),
			]);
			const result = await lookup(chain);
			expect(result.different).toEqual([
				entry(different),
				entry(different, 1n),
				entry(`${QUESTION} `),
				entry(QUESTION.toUpperCase()),
			]);
			expect(result.matching).toHaveLength(matching.length ? 1 : 0);
			expect(chain.calls).toHaveLength(matching.length ? 2 : 0);
		}
	});

	it("retains repeated and re-asked matching IDs and uses the current mapping once", async () => {
		const current = questionId(QUESTION, CONFIG, 2n);
		const chain = fakeChain([...pair(), ...pair(QUESTION, 1n), ...pair(QUESTION, 2n)], { current });
		expect((await lookup(chain)).matching).toEqual(
			[0n, 1n, 2n].map((nonce) => ({
				...entry(QUESTION, nonce),
				currentQuestionId: current,
				executed: false,
			})),
		);
		expect(chain.calls).toHaveLength(2);
	});

	it("matches a nonzero-nonce ask even without the nonce-0 question", async () => {
		const current = questionId(QUESTION, CONFIG, 1n);
		const chain = fakeChain(pair(QUESTION, 1n), { current });
		expect((await lookup(chain)).matching).toEqual([
			{ ...entry(QUESTION, 1n), currentQuestionId: current, executed: false },
		]);
	});

	it.each([
		zeroHash,
		`0x${"ff".repeat(32)}` as Hex,
	])("preserves a cleared or invalidated current mapping %s", async (current) => {
		const chain = fakeChain(pair(), { current });
		expect((await lookup(chain)).matching[0].currentQuestionId).toBe(current);
	});

	it("throws when a module question has no oracle log, including beside a match", async () => {
		const id = questionId("missing", CONFIG);
		const chain = fakeChain([...pair(), moduleLog(id)]);
		await expect(lookup(chain)).rejects.toThrow(`expected one LogNewQuestion for ${id}`);
	});

	it("refuses question logs from another oracle or after the snapshot", async () => {
		const chain = fakeChain([
			moduleLog(PROPOSAL.questionId),
			oracleLog(QUESTION, 0n, FROM, namedAddress("other oracle")),
			oracleLog(QUESTION, 0n, HEAD + 1n),
		]);
		await expect(lookup(chain)).rejects.toThrow("found 0");
	});

	it("refuses ambiguous oracle logs for a question", async () => {
		const chain = fakeChain([...pair(), oracleLog()]);
		await expect(lookup(chain)).rejects.toThrow("found 2");
	});

	it("uses oracle address and question ID filters at the module event block", async () => {
		const chain = fakeChain([
			moduleLog(PROPOSAL.questionId),
			oracleLog(),
			oracleLog(QUESTION, 0n, FROM, namedAddress("other oracle")),
			oracleLog("unrelated"),
		]);
		expect((await lookup(chain)).matching).toHaveLength(1);
		expect(chain.filters[1]).toEqual({
			address: CONFIG.oracle,
			topics: encodeEventTopics({
				abi: REALITY_ETH_ERC20_ABI,
				eventName: "LogNewQuestion",
				args: { question_id: PROPOSAL.questionId },
			}),
			fromBlock: toHex(FROM),
			toBlock: toHex(FROM),
		});
	});

	it("handles lowercase configuration and ignores other modules, CIDs and out-of-range logs", async () => {
		const chain = fakeChain([
			...pair(),
			...pair("before", 0n, FROM - 1n),
			...pair("after", 0n, HEAD + 1n),
			moduleLog(questionId("other CID", CONFIG), FROM, "another CID"),
			moduleLog(
				questionId("other module", CONFIG),
				FROM,
				PROPOSAL.proposalId,
				namedAddress("other module"),
			),
		]);
		const result = await findProposal(
			chain.client,
			{
				...SETTINGS,
				module: CONFIG.module.toLowerCase() as Address,
				oracle: CONFIG.oracle.toLowerCase() as Address,
			},
			PROPOSAL,
		);
		expect(result.matching).toHaveLength(1);
		expect(result.different).toEqual([]);
	});

	it("pins all logs and reads to one uncached latest block, including logs at the head", async () => {
		const chain = fakeChain(pair(QUESTION, 0n, HEAD));
		expect((await lookup(chain)).matching).toHaveLength(1);
		expect(chain.headRequests()).toBe(1);
		expect(chain.filters.every(({ toBlock }) => toBlock === toHex(HEAD))).toBe(true);
		expect(chain.calls.every(({ blockTag }) => blockTag === toHex(HEAD))).toBe(true);
		await lookup(chain);
		expect(chain.headRequests()).toBe(2);
		expect(chain.calls.at(-1)?.blockTag).toBe(toHex(HEAD + 1n));
	});

	it("accepts an explicit block snapshot without reading the head", async () => {
		const chain = fakeChain(pair());
		const result = await findProposal(
			chain.client,
			{ ...SETTINGS, blockNumber: HEAD - 1n },
			PROPOSAL,
		);
		expect(result.blockNumber).toBe(HEAD - 1n);
		expect(chain.headRequests()).toBe(0);
		expect(chain.calls.every(({ blockTag }) => blockTag === toHex(HEAD - 1n))).toBe(true);
	});

	it("does not request an inverted log range when the start is after the snapshot", async () => {
		const chain = fakeChain();
		expect(
			await findProposal(chain.client, { ...SETTINGS, fromBlock: HEAD + 1n }, PROPOSAL),
		).toEqual({ blockNumber: HEAD, matching: [], different: [] });
		expect(chain.filters).toEqual([]);
	});

	it.each([
		"eth_blockNumber",
		"eth_getLogs",
		"eth_call",
	])("retries failed %s requests", async (failMethod) => {
		const chain = fakeChain(pair(), { failMethod });
		expect((await lookup(chain)).matching).toHaveLength(1);
		expect(chain.failures()).toBeGreaterThanOrEqual(3);
	});
});
