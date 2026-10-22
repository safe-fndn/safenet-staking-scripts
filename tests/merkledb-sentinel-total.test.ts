import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Address, zeroHash } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { MerkleDb } from "../src/merkledb/index.js";
import { totalRewardsAmount } from "../src/utils/args.js";
import { writeJsonFile } from "../src/utils/json.js";
import { AEGIS_REWARDS_START, BETA_REWARDS_UNTIL, BETA_TOKEN_TOTAL } from "../src/utils/sep.js";
import { namedAddress, parseSafe } from "./harness/utils.js";

const TWO_WEEKS = BigInt(60 * 60 * 24 * 7 * 2);

// The `n`-th two week rewards period of the Aegis program, counting from zero.
const period = (n: number) => ({
	fromTimestamp: AEGIS_REWARDS_START + BigInt(n) * TWO_WEEKS,
	toTimestamp: AEGIS_REWARDS_START + BigInt(n + 1) * TWO_WEEKS,
});

const roots = [] as string[];

/**
 * Creates a temporary rewards directory holding a `latest.json` that has nothing distributed yet
 * and is caught up to the very start of the rewards program.
 */
const createRewardsDirectory = async (index?: Record<string, unknown>): Promise<string> => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "safenet-merkledb-"));
	roots.push(root);
	await writeJsonFile(path.join(root, "latest.json"), {
		epoch: 0,
		merkleRoot: zeroHash,
		tokenTotal: 0n,
		rewardsUntil: new Date(Number(AEGIS_REWARDS_START) * 1000),
		...index,
	});
	return root;
};

/**
 * Creates a temporary rewards directory with the Beta token total distributed in its last period,
 * so that it is caught up to the end of Beta exactly like the pinned rewards DB.
 */
const createBetaRewardsDirectory = async (): Promise<string> => {
	const root = await createRewardsDirectory({
		rewardsUntil: new Date(Number(BETA_REWARDS_UNTIL - TWO_WEEKS) * 1000),
	});
	await new MerkleDb({ root }).distribute(
		{ fromTimestamp: BETA_REWARDS_UNTIL - TWO_WEEKS, toTimestamp: BETA_REWARDS_UNTIL },
		{ [namedAddress("beta")]: { amount: BETA_TOKEN_TOTAL, sentinelAmount: 0n } },
		0n,
		{ sanctions: [], kycApprovals: [] },
	);
	return root;
};

/**
 * Reads the raw distribution entry written for `account`, as it lands on disk.
 */
const readEntry = async (root: string, account: string): Promise<Record<string, unknown>> => {
	const pattern = path.join(root, "proofs", "**", `${account.toLowerCase()}.json`);
	for await (const entry of fs.glob(pattern)) {
		return JSON.parse(await fs.readFile(entry, "utf8"));
	}
	throw new Error(`no distribution entry for ${account}`);
};

const budget = (root: string, n: number) => {
	const { fromTimestamp, toTimestamp } = period(n);
	return totalRewardsAmount(
		{ rewardPeriodStart: fromTimestamp, rewardPeriodEnd: toTimestamp },
		new MerkleDb({ root }),
	);
};

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await fs.rm(root, { recursive: true, force: true });
	}
});

describe("merkledb sentinel total", () => {
	it("defaults the sentinel total for records written before sentinel rewards", async () => {
		const root = await createRewardsDirectory({ tokenTotal: parseSafe("1000") });
		const index = await new MerkleDb({ root }).index();
		expect(index).toMatchObject({
			tokenTotal: parseSafe("1000"),
			sentinelTokenTotal: 0n,
		});
	});

	it("leaves the validator budget unaffected by sentinel spend", async () => {
		const validator = namedAddress("validator");
		const sentinel = namedAddress("sentinel");

		// Both records distribute the exact same validator payouts; the mixed one additionally
		// pays a sentinel out of the same distribution.
		const validatorPayout = parseSafe("150000");
		const sentinelPayout = parseSafe("15000");

		const baselineRoot = await createBetaRewardsDirectory();
		const baseline = new MerkleDb({ root: baselineRoot });
		const mixedRoot = await createBetaRewardsDirectory();
		const mixed = new MerkleDb({ root: mixedRoot });

		for (const n of [0, 1]) {
			const baselineUpdate = await baseline.distribute(
				period(n),
				{ [validator]: { amount: validatorPayout, sentinelAmount: 0n } },
				0n,
				{ sanctions: [], kycApprovals: [] },
			);
			const mixedUpdate = await mixed.distribute(
				period(n),
				{
					[validator]: { amount: validatorPayout, sentinelAmount: 0n },
					[sentinel]: { amount: sentinelPayout, sentinelAmount: sentinelPayout },
				},
				0n,
				{ sanctions: [], kycApprovals: [] },
			);

			// The transfer to the cumulative Merkle drop funds both programs, so it *is* larger.
			expect(baselineUpdate?.additionalAmount).toBe(validatorPayout);
			expect(mixedUpdate?.additionalAmount).toBe(validatorPayout + sentinelPayout);
		}

		// After two periods, the mixed record has distributed 30,000 SAFE more in total, all of
		// it sentinel spend.
		expect(await baseline.index()).toMatchObject({
			tokenTotal: BETA_TOKEN_TOTAL + 2n * validatorPayout,
			sentinelTokenTotal: 0n,
		});
		expect(await mixed.index()).toMatchObject({
			tokenTotal: BETA_TOKEN_TOTAL + 2n * (validatorPayout + sentinelPayout),
			sentinelTokenTotal: 2n * sentinelPayout,
		});

		// 5M SAFE over 52 weeks, so the first 6 weeks of Aegis are worth
		// 576,923.076923076923076923 SAFE, of which 300,000 SAFE has already been paid out to
		// validators over the two periods above. Neither the Beta token total nor the 30,000 SAFE
		// of sentinel spend reduce the budget.
		expect(await budget(baselineRoot, 2)).toBe(parseSafe("276923.076923076923076923"));
		expect(await budget(mixedRoot, 2)).toBe(await budget(baselineRoot, 2));
	});

	it("splits a merged validator and sentinel payout within one entry", async () => {
		// A sentinel that also runs a validator claims both programs from a single entry, so the
		// sentinel share has to be tracked per entry rather than inferred from the payout.
		const both = namedAddress("validator-and-sentinel");
		const root = await createRewardsDirectory();
		const db = new MerkleDb({ root });

		for (const n of [0, 1]) {
			await db.distribute(
				period(n),
				{ [both]: { amount: parseSafe("40000"), sentinelAmount: parseSafe("15000") } },
				0n,
				{ sanctions: [], kycApprovals: [] },
			);
		}

		expect(await readEntry(root, both)).toMatchObject({
			cumulativeAmount: parseSafe("80000").toString(),
			sentinelAmount: parseSafe("30000").toString(),
		});
		expect(await db.index()).toMatchObject({
			tokenTotal: parseSafe("80000"),
			sentinelTokenTotal: parseSafe("30000"),
		});
	});

	it("recomputes the sentinel total from the distribution entries", async () => {
		// The total is derived, not accumulated: an entry edited on disk is picked up by the
		// next rebuild, exactly as `tokenTotal` is.
		const sentinel = namedAddress("sentinel");
		const root = await createRewardsDirectory();
		const db = new MerkleDb({ root });

		await db.distribute(
			period(0),
			{ [sentinel]: { amount: parseSafe("15000"), sentinelAmount: parseSafe("15000") } },
			0n,
			{ sanctions: [], kycApprovals: [] },
		);
		expect(await db.index()).toMatchObject({ sentinelTokenTotal: parseSafe("15000") });

		// A rebuild that distributes nothing to the sentinel leaves its total where it was.
		await db.distribute(
			period(1),
			{ [namedAddress("validator")]: { amount: parseSafe("300000"), sentinelAmount: 0n } },
			0n,
			{ sanctions: [], kycApprovals: [] },
		);
		expect(await db.index()).toMatchObject({
			tokenTotal: parseSafe("315000"),
			sentinelTokenTotal: parseSafe("15000"),
		});
	});

	it("rejects a payout keyed by a non-checksummed address", async () => {
		// Payout keys are expected to be checksummed already; a lowercase key used to miss its own
		// lookup and fail with an opaque `Cannot mix BigInt and other types` error instead.
		const root = await createRewardsDirectory();
		const db = new MerkleDb({ root });
		const account = namedAddress("validator").toLowerCase() as Address;

		await expect(
			db.distribute(
				period(0),
				{ [account]: { amount: parseSafe("300000"), sentinelAmount: 0n } },
				0n,
				{ sanctions: [], kycApprovals: [] },
			),
		).rejects.toThrow(`"${account}" is not a checksummed address`);
		expect(await db.index()).toMatchObject({ tokenTotal: 0n });
	});

	it("preserves the sentinel total across a KYC rebuild", async () => {
		const root = await createRewardsDirectory();
		const db = new MerkleDb({ root });
		const sentinel = namedAddress("sentinel");
		const sentinelPayout = parseSafe("15000");

		// A KYC update rebuilds the tree without distributing anything, so it must leave the
		// accumulated sentinel total alone.
		const update = await db.distribute(
			period(0),
			{ [sentinel]: { amount: sentinelPayout, sentinelAmount: sentinelPayout } },
			0n,
			{ sanctions: [], kycApprovals: [] },
		);
		expect(update).not.toBeNull();

		await db.kyc(period(0), [sentinel], []);
		expect(await db.index()).toMatchObject({
			tokenTotal: sentinelPayout,
			sentinelTokenTotal: sentinelPayout,
		});
	});
});
