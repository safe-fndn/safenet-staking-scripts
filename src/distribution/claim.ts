/**
 * The claim bundle of a finalized Reality.eth question: `claimWinnings` with the question's answer
 * history.
 *
 * `claimWinnings` walks the history from the newest answer back, checking each entry against the
 * question's stored history hash, and credits the bonds and bounty to the winners' oracle balances.
 * Anyone can call it for any winner. The bundle does not `withdraw`: the oracle spends a balance
 * before pulling tokens for the next bond, so keeping it there saves gas. The calls follow
 * `RealityETH_ERC20-3.0.sol` of `RealityETH`.
 */

import debug from "debug";
import {
	type Address,
	type Client,
	encodeFunctionData,
	encodePacked,
	type Hex,
	keccak256,
	zeroHash,
} from "viem";
import { getBlockNumber, getContractEvents, readContract } from "viem/actions";
import { REALITY_ETH_ERC20_ABI } from "../abi.js";
import { type Backoff, backoff } from "../utils/backoff.js";
import { type TransactionBundle, transactionBundle } from "../utils/bundle.js";

/** One `LogNewAnswer` of a question, in the order the oracle recorded them. */
export type Answer = {
	answer: Hex;
	/** The question's history hash after this answer. */
	historyHash: Hex;
	user: Address;
	bond: bigint;
	isCommitment: boolean;
};

/** The state of a question that its claim is built from, read at one block. */
export type QuestionClaim = {
	blockNumber: bigint;
	questionId: Hex;
	finalized: boolean;
	finalizeTimestamp: bigint;
	/** The history hash still to be claimed; zero once the question is fully claimed. */
	historyHash: Hex;
	/** Every answer, oldest first. */
	answers: Answer[];
	/** The oracle balance of every answerer. */
	balances: Record<Address, bigint>;
};

/** The arguments of `claimWinnings`, newest answer first. */
export type ClaimArguments = {
	historyHashes: Hex[];
	addrs: Address[];
	bonds: bigint[];
	answers: Hex[];
};

/**
 * Reads a question's claim state and every answer from the oracle at `blockNumber`, or at the
 * latest block if it is unset.
 */
export const questionClaim = async (
	client: Client,
	{ oracle, questionId, blockNumber }: { oracle: Address; questionId: Hex; blockNumber?: bigint },
	options: { withBackoff?: Backoff } = {},
): Promise<QuestionClaim> => {
	const withBackoff = options.withBackoff ?? backoff({ debug: debug("safenet:claim") });
	const block = blockNumber ?? (await withBackoff(() => getBlockNumber(client, { cacheTime: 0 })));
	const at = { address: oracle, abi: REALITY_ETH_ERC20_ABI, args: [questionId] as const };
	const [finalized, finalizeTimestamp, historyHash, logs] = await Promise.all([
		withBackoff(() =>
			readContract(client, { ...at, functionName: "isFinalized", blockNumber: block }),
		),
		withBackoff(() =>
			readContract(client, { ...at, functionName: "getFinalizeTS", blockNumber: block }),
		),
		withBackoff(() =>
			readContract(client, { ...at, functionName: "getHistoryHash", blockNumber: block }),
		),
		withBackoff(() =>
			getContractEvents(client, {
				address: oracle,
				abi: REALITY_ETH_ERC20_ABI,
				eventName: "LogNewAnswer",
				args: { question_id: questionId },
				fromBlock: 0n,
				toBlock: block,
				strict: true,
			}),
		),
	]);
	const users = [...new Set(logs.map(({ args }) => args.user))];
	const balances = await Promise.all(
		users.map((user) =>
			withBackoff(() =>
				readContract(client, {
					address: oracle,
					abi: REALITY_ETH_ERC20_ABI,
					functionName: "balanceOf",
					args: [user],
					blockNumber: block,
				}),
			),
		),
	);
	return {
		blockNumber: block,
		questionId,
		finalized,
		finalizeTimestamp: BigInt(finalizeTimestamp),
		historyHash,
		answers: logs.map(({ args }) => ({
			answer: args.answer,
			historyHash: args.history_hash,
			user: args.user,
			bond: args.bond,
			isCommitment: args.is_commitment,
		})),
		balances: Object.fromEntries(users.map((user, i) => [user, balances[i]])),
	};
};

/**
 * The `claimWinnings` arguments for the answers not claimed yet, newest first.
 *
 * Every answer's history hash is recomputed from the one before it, so the arguments are exactly
 * what the oracle verifies. After a partial claim the stored history hash is that of an older
 * answer, and only the answers up to it are claimed.
 *
 * It throws if the question is not finalized, is already claimed, has a commitment (which needs a
 * reveal first) or has a history that does not hash to the stored history hash.
 */
export const claimArguments = (claim: QuestionClaim): ClaimArguments => {
	const { questionId } = claim;
	if (!claim.finalized) {
		throw new Error(`question ${questionId} is not finalized`);
	}
	if (claim.historyHash === zeroHash) {
		throw new Error(`question ${questionId} is already claimed`);
	}
	let previous: Hex = zeroHash;
	const entries: (Answer & { previousHash: Hex })[] = [];
	for (const answer of claim.answers) {
		if (answer.isCommitment) {
			throw new Error(`question ${questionId} has a commitment by ${answer.user}`);
		}
		const hash = keccak256(
			encodePacked(
				["bytes32", "bytes32", "uint256", "address", "bool"],
				[previous, answer.answer, answer.bond, answer.user, false],
			),
		);
		if (hash !== answer.historyHash) {
			throw new Error(`answer history of question ${questionId} does not hash to ${hash}`);
		}
		entries.push({ ...answer, previousHash: previous });
		previous = hash;
		if (hash === claim.historyHash) break;
	}
	if (previous !== claim.historyHash) {
		throw new Error(
			`answer history of question ${questionId} does not reach history hash ${claim.historyHash}`,
		);
	}
	entries.reverse();
	return {
		historyHashes: entries.map(({ previousHash }) => previousHash),
		addrs: entries.map(({ user }) => user),
		bonds: entries.map(({ bond }) => bond),
		answers: entries.map(({ answer }) => answer),
	};
};

/**
 * `claim.json`: `claimWinnings` for the answers not claimed yet. It is created at the question's
 * finalization, in milliseconds since the Unix epoch, so that it does not depend on when it was
 * built.
 *
 * It returns the bundle together with the `claimArguments` it encodes, so that callers can use
 * both without being able to pair a claim with arguments derived from another.
 */
export const claimBundle = (
	oracle: Address,
	claim: QuestionClaim,
): [TransactionBundle, ClaimArguments] => {
	const args = claimArguments(claim);
	const { historyHashes, addrs, bonds, answers } = args;
	const bundle = transactionBundle(
		[
			{
				to: oracle,
				data: encodeFunctionData({
					abi: REALITY_ETH_ERC20_ABI,
					functionName: "claimWinnings",
					args: [claim.questionId, historyHashes, addrs, bonds, answers],
				}),
			},
		],
		Number(claim.finalizeTimestamp) * 1000,
	);
	return [bundle, args];
};
