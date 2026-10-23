/** Proposal lookup against one snapshot of the Reality Module and its oracle. */
import debug from "debug";
import { type Address, type Client, type Hex, keccak256, toHex } from "viem";
import { getBlockNumber, getContractEvents, readContract } from "viem/actions";
import { REALITY_ETH_ERC20_ABI, REALITY_MODULE_ABI } from "../abi.js";
import { type Backoff, backoff } from "../utils/backoff.js";
import { buildQuestion, type Proposal } from "./transactions.js";

export type ProposalQuestion = { questionId: Hex; question: string };

export type OnchainProposal = {
	blockNumber: bigint;
	/** All matching question IDs, including earlier asks with the same text. */
	matching: (ProposalQuestion & { currentQuestionId: Hex; executed: boolean })[];
	/** Every different question for the CID, even when a matching question exists. */
	different: ProposalQuestion[];
};

/**
 * Finds questions for the proposal's CID from the inclusive `fromBlock` through the latest block
 * (or an explicit snapshot). Matching is exact question text, independent of the nonce-0 ID in
 * `proposal`. The current module mapping and execution flag belong to the question text hash,
 * shared by every re-ask. Missing oracle logs throw rather than imply there is no proposal.
 */
export const findProposal = async (
	client: Client,
	{
		module,
		oracle,
		fromBlock,
		blockNumber,
	}: { module: Address; oracle: Address; fromBlock: bigint; blockNumber?: bigint },
	proposal: Pick<Proposal, "proposalId" | "transaction">,
	options: { withBackoff?: Backoff } = {},
): Promise<OnchainProposal> => {
	const withBackoff = options.withBackoff ?? backoff({ debug: debug("safenet:onchain") });
	const block = blockNumber ?? (await withBackoff(() => getBlockNumber(client, { cacheTime: 0 })));
	const result: OnchainProposal = { blockNumber: block, matching: [], different: [] };
	if (fromBlock > block) return result;
	const logs = await withBackoff(() =>
		getContractEvents(client, {
			address: module,
			abi: REALITY_MODULE_ABI,
			eventName: "ProposalQuestionCreated",
			args: { proposalId: proposal.proposalId },
			fromBlock,
			toBlock: block,
			strict: true,
		}),
	);
	const expected = buildQuestion(proposal.proposalId, [proposal.transaction.hash]);
	const matching: ProposalQuestion[] = [];
	const seen = new Set<Hex>();
	for (const {
		args: { questionId },
		blockNumber: questionBlock,
	} of logs) {
		if (seen.has(questionId)) continue;
		seen.add(questionId);
		const questions = await withBackoff(() =>
			getContractEvents(client, {
				address: oracle,
				abi: REALITY_ETH_ERC20_ABI,
				eventName: "LogNewQuestion",
				args: { question_id: questionId },
				// The module asks the oracle before emitting ProposalQuestionCreated in the same call.
				fromBlock: questionBlock,
				toBlock: questionBlock,
				strict: true,
			}),
		);
		if (questions.length !== 1) {
			throw new Error(
				`expected one LogNewQuestion for ${questionId} from oracle ${oracle}, found ${questions.length}`,
			);
		}
		const question = { questionId, question: questions[0].args.question };
		(question.question === expected ? matching : result.different).push(question);
	}
	if (matching.length > 0) {
		const questionHash = keccak256(toHex(expected));
		const [currentQuestionId, executed] = await Promise.all([
			withBackoff(() =>
				readContract(client, {
					address: module,
					abi: REALITY_MODULE_ABI,
					functionName: "questionIds",
					args: [questionHash],
					blockNumber: block,
				}),
			),
			withBackoff(() =>
				readContract(client, {
					address: module,
					abi: REALITY_MODULE_ABI,
					functionName: "executedProposalTransactions",
					args: [questionHash, proposal.transaction.hash],
					blockNumber: block,
				}),
			),
		]);
		result.matching = matching.map((question) => ({ ...question, currentQuestionId, executed }));
	}
	return result;
};
