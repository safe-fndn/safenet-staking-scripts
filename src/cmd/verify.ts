/** Re-derives the next reward distribution and checks every onchain question for its CID. */

import { z } from "zod";
import { AEGIS_PARAMETERS } from "../config/aegis.js";
import { verifyProposal } from "../distribution/verify.js";
import { Safenet } from "../safenet.js";
import { main } from "../utils/args.js";
import { formatSafeToken, formatTimestamp } from "../utils/format.js";

const amount = (value: bigint): string => `${formatSafeToken(value).trim()} SAFE`;

main(
	{
		previousCar: z.string().min(1).optional(),
		cid: z.string().min(1).optional(),
		ipfsGatewayUrl: z.url().optional(),
	},
	async (args) => {
		const config = { ...args, ...AEGIS_PARAMETERS };
		const safenet = await Safenet.create(config);
		const { distribution: result, onchain, outcome } = await verifyProposal(safenet, config);
		let stakeRewards = 0n;
		let commission = 0n;
		let sentinelRewards = 0n;
		for (const split of Object.values(result.payouts)) {
			stakeRewards += split.stakeRewards;
			commission += split.commission;
			sentinelRewards += split.sentinelRewards;
		}
		console.log(`Previous CID:       ${result.previous.cid}`);
		console.log(
			`Period:             ${formatTimestamp(result.period.fromTimestamp)} → ` +
				`${formatTimestamp(result.period.toTimestamp)}, ` +
				`settled at consensus block ${result.settlement.settlementBlock}`,
		);
		console.log(`Package CID:        ${result.cid}`);
		console.log(`Merkle Root:        ${result.merkleRoot}`);
		console.log(`Additional Amount:  ${amount(result.additionalAmount)}`);
		console.log(`Distribution:       ${amount(stakeRewards + commission + sentinelRewards)}`);
		console.log(
			`Validator Rewards:  ${amount(stakeRewards + commission)} of ${amount(result.totalRewards)} ` +
				`(stake rewards ${amount(stakeRewards)}, commission ${amount(commission)}, ` +
				`unpaid ${amount(result.unpaid)})`,
		);
		console.log(
			`Sentinel Rewards:   ${amount(sentinelRewards)} ` +
				`(${amount(result.sentinelRewards)} each, forfeited ${amount(result.forfeited)})`,
		);
		console.log(`Sanctions Lists:    ${result.sanctionsRelease}`);
		console.log(`New KYC Approvals:  ${result.newlyApproved.length}`);
		for (const account of result.newlyApproved) {
			console.log(`New KYC Approval:   ${account}`);
		}
		console.log(`Transaction Hash:   ${result.proposal.transaction.hash}`);
		console.log(`Onchain Block:      ${onchain.blockNumber}`);
		const matching = onchain.matching[0];
		if (matching !== undefined) {
			// The mapping and execution flag belong to the question text, shared by all re-asks.
			// Print the raw mapping even when it is cleared or invalidated.
			console.log(
				`Proposal:           current question mapping ${matching.currentQuestionId}, ` +
					(matching.executed ? "executed" : "not executed"),
			);
			for (const question of onchain.matching) {
				console.log(`Matching Question:  ${question.questionId}`);
			}
		} else {
			console.log(
				`Proposal:           ${outcome === "none yet" ? "none yet" : "no matching question"}`,
			);
		}
		for (const question of onchain.different) {
			console.log(
				`Other questions:    ${question.questionId} proposes a different transaction for this CID: answer No`,
			);
		}
		const cidMismatch = args.cid !== undefined && args.cid !== result.cid.toString();
		if (cidMismatch) {
			console.error(`CID mismatch: expected ${args.cid}, derived ${result.cid}`);
		}
		if (cidMismatch || outcome === "different") {
			console.log("FAILED");
			process.exitCode = 1;
		} else {
			console.log("OK");
		}
	},
);
