import { type Hex, zeroHash } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AEGIS_PARAMETERS } from "../src/config/aegis.js";
import { actionBundles } from "../src/distribution/actions.js";
import { buildQuestion, proposal, questionId } from "../src/distribution/transactions.js";
import type { Verification } from "../src/distribution/verify.js";
import { CONFIG, UPDATE } from "./harness/governance.js";
import { namedAddress, parseSafe } from "./harness/utils.js";

const mocks = vi.hoisted(() => ({ create: vi.fn(), verify: vi.fn() }));
vi.mock("../src/safenet.js", () => ({ Safenet: { create: mocks.create } }));
vi.mock("../src/distribution/verify.js", () => ({ verifyProposal: mocks.verify }));
vi.mock("dotenv", () => ({ configDotenv: vi.fn() }));

const PROPOSAL = proposal(UPDATE, CONFIG);
const QUESTION = buildQuestion(PROPOSAL.proposalId, [PROPOSAL.transaction.hash]);
const ACTOR = namedAddress("staker");
const originalArgv = process.argv;
let originalExitCode: typeof process.exitCode;
let result: Verification;

beforeEach(() => {
	vi.resetModules();
	originalExitCode = process.exitCode;
	process.exitCode = 0;
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	const environment = {
		DATABASE_FILE: ":memory:",
		STAKING_RPC_URL: "https://staking.invalid",
		STAKING_BLOCK_PAGE_SIZE: "100",
		CONSENSUS_RPC_URL: "https://consensus.invalid",
		CONSENSUS_BLOCK_PAGE_SIZE: "25",
	};
	for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
	for (const key of ["CID", "PREVIOUS_CAR", "IPFS_GATEWAY_URL", "DEBUG"])
		vi.stubEnv(key, undefined);
	result = {
		distribution: {
			stakingChainId: 1,
			blockNumber: 100n,
			governance: CONFIG,
			previous: { cid: UPDATE.cid, merkleRoot: zeroHash, rewardsUntil: 0n },
			period: { fromTimestamp: 0n, toTimestamp: 60n },
			totalRewards: parseSafe("11"),
			sentinelRewards: parseSafe("2"),
			settlement: { boundaryBlock: 12n, settlementBlock: 60n, settlementTimestamp: 300n },
			payouts: {
				[ACTOR]: {
					stakeRewards: parseSafe("7.000000000000000001"),
					commission: parseSafe("1"),
					sentinelRewards: parseSafe("2"),
				},
				[namedAddress("delegator")]: {
					stakeRewards: parseSafe("2"),
					commission: 0n,
					sentinelRewards: 0n,
				},
			},
			unpaid: parseSafe("0.999999999999999999"),
			forfeited: parseSafe("2"),
			sanctionsRelease: "data-2026-10-26",
			additionalAmount: UPDATE.additionalAmount,
			merkleRoot: UPDATE.merkleRoot,
			newlyApproved: [ACTOR],
			cid: UPDATE.cid,
			car: new Uint8Array(),
			proposal: PROPOSAL,
			bundles: actionBundles(PROPOSAL, CONFIG, 300n),
		},
		onchain: { blockNumber: 101n, matching: [], different: [] },
		outcome: "none yet",
	};
	mocks.create.mockResolvedValue({});
	mocks.verify.mockImplementation(async () => result);
});

afterEach(() => {
	process.argv = originalArgv;
	process.exitCode = originalExitCode;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

const run = async (...flags: string[]) => {
	process.argv = [originalArgv[0], "src/cmd/verify.ts", ...flags];
	await import("../src/cmd/verify.js");
	await vi.waitFor(
		() => {
			const finished = vi
				.mocked(console.log)
				.mock.calls.some(([line]) => line === "OK" || line === "FAILED");
			expect(finished || vi.mocked(console.error).mock.calls.length > 0).toBe(true);
		},
		{ interval: 1 },
	);
	return vi
		.mocked(console.log)
		.mock.calls.map(([line]) => line)
		.join("\n");
};

const matching = (current = questionId(QUESTION, CONFIG, 2n), executed = false) => {
	result.outcome = "matching";
	result.onchain.matching = [0n, 2n].map((nonce) => ({
		questionId: questionId(QUESTION, CONFIG, nonce),
		question: QUESTION,
		currentQuestionId: current,
		executed,
	}));
};

describe("cmd:verify", () => {
	it("prints the derived summary exactly, preserving wei and merged reward splits", async () => {
		const output = await run("--cid", UPDATE.cid.toString(), "--previousCar", "previous.car");
		// Stake = 7 SAFE + 1 wei + 2 SAFE; commission = 1 SAFE; sentinels = 2 SAFE.
		// Validator unpaid = 11 SAFE - (10 SAFE + 1 wei); total earned = 12 SAFE + 1 wei.
		expect(output).toBe(
			[
				`Previous CID:       ${UPDATE.cid}`,
				"Period:             1970-01-01T00:00:00.000Z → 1970-01-01T00:01:00.000Z, settled at consensus block 60",
				`Package CID:        ${UPDATE.cid}`,
				`Merkle Root:        ${UPDATE.merkleRoot}`,
				"Additional Amount:  172603.12 SAFE",
				"Distribution:       12.000000000000000001 SAFE",
				"Validator Rewards:  10.000000000000000001 SAFE of 11.0 SAFE (stake rewards 9.000000000000000001 SAFE, commission 1.0 SAFE, unpaid 0.999999999999999999 SAFE)",
				"Sentinel Rewards:   2.0 SAFE (2.0 SAFE each, forfeited 2.0 SAFE)",
				"Sanctions Lists:    data-2026-10-26",
				"New KYC Approvals:  1",
				`New KYC Approval:   ${ACTOR}`,
				`Transaction Hash:   ${PROPOSAL.transaction.hash}`,
				"Onchain Block:      101",
				"Proposal:           none yet",
				"OK",
			].join("\n"),
		);
		expect(process.exitCode).toBe(0);
		expect(console.error).not.toHaveBeenCalled();
		const args = mocks.create.mock.calls[0][0];
		expect(args).toMatchObject({
			...AEGIS_PARAMETERS,
			previousCar: "previous.car",
			cid: UPDATE.cid.toString(),
		});
		expect(mocks.verify).toHaveBeenCalledExactlyOnceWith(
			await mocks.create.mock.results[0].value,
			args,
		);
	});

	it("accepts no CID and reports zero new approvals", async () => {
		result.distribution.newlyApproved = [];
		expect(await run()).toContain("New KYC Approvals:  0");
		expect(process.exitCode).toBe(0);
	});

	it.each([
		false,
		true,
	])("reports the current re-asked mapping with executed=%s", async (executed) => {
		const current = questionId(QUESTION, CONFIG, 2n);
		matching(current, executed);
		const output = await run();
		expect(output).toContain(
			`Proposal:           current question mapping ${current}, ${executed ? "executed" : "not executed"}`,
		);
		for (const question of result.onchain.matching) {
			expect(output).toContain(`Matching Question:  ${question.questionId}`);
		}
		expect(process.exitCode).toBe(0);
	});

	it.each([
		zeroHash,
		`0x${"ff".repeat(32)}` as Hex,
	])("preserves cleared/invalidated mapping %s", async (current) => {
		matching(current);
		expect(await run()).toContain(`current question mapping ${current}, not executed`);
		expect(process.exitCode).toBe(0);
	});

	it.each([false, true])("names every conflict and fails with matching=%s", async (hasMatch) => {
		if (hasMatch) matching();
		result.outcome = "different";
		result.onchain.different = ["first", "second"].map((question) => ({
			question,
			questionId: questionId(question, CONFIG),
		}));
		const output = await run("--cid", UPDATE.cid.toString());
		for (const question of result.onchain.different) {
			expect(output).toContain(
				`Other questions:    ${question.questionId} proposes a different transaction for this CID: answer No`,
			);
		}
		if (hasMatch)
			expect(output).toContain(
				`current question mapping ${result.onchain.matching[0].currentQuestionId}`,
			);
		else expect(output).toContain("Proposal:           no matching question");
		expect(output).toMatch(/FAILED$/);
		expect(process.exitCode).toBe(1);
	});

	it.each([
		false,
		true,
	])("fails a CID mismatch with matching=%s and names expected/derived CIDs", async (hasMatch) => {
		if (hasMatch) matching();
		const output = await run("--cid", "another-cid");
		expect(console.error).toHaveBeenCalledExactlyOnceWith(
			`CID mismatch: expected another-cid, derived ${UPDATE.cid}`,
		);
		expect(output).toMatch(/FAILED$/);
		expect(process.exitCode).toBe(1);
	});

	it("accepts CID, previous CAR and gateway through environment variables", async () => {
		vi.stubEnv("CID", UPDATE.cid.toString());
		vi.stubEnv("PREVIOUS_CAR", "previous.car");
		vi.stubEnv("IPFS_GATEWAY_URL", "https://gateway.invalid");
		await run();
		expect(mocks.verify.mock.calls[0][1]).toMatchObject({
			cid: UPDATE.cid.toString(),
			previousCar: "previous.car",
			ipfsGatewayUrl: "https://gateway.invalid",
		});
		expect(process.exitCode).toBe(0);
	});

	it("uses main's nonzero error handling on a verification failure", async () => {
		const error = new Error("RPC lookup failed");
		mocks.verify.mockRejectedValueOnce(error);
		expect(await run()).not.toContain("OK");
		expect(console.error).toHaveBeenCalledExactlyOnceWith(error);
		expect(process.exitCode).toBe(1);
	});

	it.each([
		"out",
		"rewardPeriodStart",
		"rewardPeriodEnd",
		"release",
		"postExecution",
		"proposal",
		"question",
		"totalRewards",
		"sentinelRewards",
		"minPayout",
		"kycThreshold",
	])("rejects unsupported --%s before creating Safenet", async (flag) => {
		await expect(run(`--${flag}=unused`)).rejects.toThrow(`Unknown option '--${flag}'`);
		expect(mocks.create).not.toHaveBeenCalled();
	});
});
