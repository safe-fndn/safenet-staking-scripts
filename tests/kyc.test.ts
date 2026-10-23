import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Address, zeroHash } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { kyc } from "../src/distribution/kyc.js";
import { MerkleDb, type Payout } from "../src/merkledb/index.js";
import { writeJsonFile } from "../src/utils/json.js";
import { AEGIS_REWARDS_START } from "../src/utils/sep.js";
import { sortByAddress } from "../src/utils/sort.js";
import { namedAddress, parseSafe } from "./harness/utils.js";

const TWO_WEEKS = BigInt(60 * 60 * 24 * 7 * 2);
const THRESHOLD = parseSafe("7500");

// The `n`-th two week rewards period of the Aegis program, counting from zero.
const period = (n: number) => ({
	fromTimestamp: AEGIS_REWARDS_START + BigInt(n) * TWO_WEEKS,
	toTimestamp: AEGIS_REWARDS_START + BigInt(n + 1) * TWO_WEEKS,
});

const [alice, bob, carol] = sortByAddress(
	[namedAddress("alice"), namedAddress("bob"), namedAddress("carol")],
	(account) => account,
);

const roots = [] as string[];

const createRewardsDirectory = async (): Promise<string> => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "safenet-kyc-"));
	roots.push(root);
	await writeJsonFile(path.join(root, "latest.json"), {
		epoch: 0,
		merkleRoot: zeroHash,
		tokenTotal: 0n,
		rewardsUntil: new Date(Number(AEGIS_REWARDS_START) * 1000),
	});
	return root;
};

const readEntry = async (root: string, account: Address): Promise<Record<string, unknown>> => {
	const pattern = path.join(root, "proofs", "**", `${account.toLowerCase()}.json`);
	for await (const entry of fs.glob(pattern)) {
		return JSON.parse(await fs.readFile(entry, "utf8"));
	}
	throw new Error(`no entry for ${account}`);
};

const payout = (amount: string): Payout => ({ amount: parseSafe(amount), sentinelAmount: 0n });

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await fs.rm(root, { recursive: true, force: true });
	}
});

describe("kyc file", () => {
	it("parses the committed file", () => {
		const { accounts, threshold } = kyc();
		expect(accounts.length).toBeGreaterThan(0);
		expect(threshold).toBeGreaterThan(0n);
	});
});

describe("kyc distribute", () => {
	it("withholds payouts at the threshold for unlisted accounts only", async () => {
		const root = await createRewardsDirectory();
		const db = new MerkleDb({ root });

		// Bob is below the threshold, Carol is exactly at it and Alice is listed.
		const update = await db.distribute(
			period(0),
			{ [alice]: payout("10000"), [bob]: payout("7499"), [carol]: payout("7500") },
			0n,
			{ sanctions: [], kycThreshold: THRESHOLD, kycApprovals: [alice] },
		);
		expect(update).toMatchObject({ newlyApproved: [alice] });

		expect(await readEntry(root, alice)).toMatchObject({
			cumulativeAmount: parseSafe("10000").toString(),
			kycAmount: "0",
			kyc: true,
		});
		expect(await readEntry(root, bob)).toMatchObject({
			cumulativeAmount: parseSafe("7499").toString(),
			kycAmount: "0",
		});
		expect(await readEntry(root, carol)).toMatchObject({
			cumulativeAmount: "0",
			kycAmount: parseSafe("7500").toString(),
			proof: null,
		});
	});

	it("releases withheld amounts for newly approved accounts", async () => {
		const root = await createRewardsDirectory();
		const db = new MerkleDb({ root });

		await db.distribute(period(0), { [alice]: payout("10000") }, 0n, {
			sanctions: [],
			kycThreshold: THRESHOLD,
			kycApprovals: [],
		});
		expect(await readEntry(root, alice)).toMatchObject({
			cumulativeAmount: "0",
			kycAmount: parseSafe("10000").toString(),
		});

		// Once approved, the withheld 10,000 SAFE and the period's 8,000 SAFE payout are both
		// released in the same rebuild. Both were already funded or are funded now, so only the
		// period's payout is additional.
		const update = await db.distribute(period(1), { [alice]: payout("8000") }, 0n, {
			sanctions: [],
			kycThreshold: THRESHOLD,
			kycApprovals: [alice],
		});
		expect(update).toMatchObject({
			additionalAmount: parseSafe("8000"),
			newlyApproved: [alice],
		});
		expect(update?.merkleRoot).not.toBe(zeroHash);
		expect(await readEntry(root, alice)).toMatchObject({
			cumulativeAmount: parseSafe("18000").toString(),
			kycAmount: "0",
			kyc: true,
		});

		// A previously approved account is not reported again.
		const next = await db.distribute(period(2), { [alice]: payout("8000") }, 0n, {
			sanctions: [],
			kycThreshold: THRESHOLD,
			kycApprovals: [alice],
		});
		expect(next).toMatchObject({ additionalAmount: parseSafe("8000"), newlyApproved: [] });
	});

	it("approves listed accounts that have no entry", async () => {
		const root = await createRewardsDirectory();
		const db = new MerkleDb({ root });

		// Bob has never been paid. Approving him creates an entry with nothing to claim, so the
		// tree only holds Alice, and his first payout above the threshold is not withheld.
		const update = await db.distribute(period(0), { [alice]: payout("100") }, 0n, {
			sanctions: [],
			kycThreshold: THRESHOLD,
			kycApprovals: [bob],
		});
		expect(update).toMatchObject({ additionalAmount: parseSafe("100"), newlyApproved: [bob] });
		expect(await readEntry(root, bob)).toMatchObject({
			cumulativeAmount: "0",
			kycAmount: "0",
			kyc: true,
			proof: null,
		});

		await db.distribute(period(1), { [bob]: payout("10000") }, 0n, {
			sanctions: [],
			kycThreshold: THRESHOLD,
			kycApprovals: [bob],
		});
		expect(await readEntry(root, bob)).toMatchObject({
			cumulativeAmount: parseSafe("10000").toString(),
			kycAmount: "0",
		});
	});

	it("refuses when a previously approved account is missing from the approvals", async () => {
		const root = await createRewardsDirectory();
		const db = new MerkleDb({ root });

		await db.distribute(period(0), { [alice]: payout("10000") }, 0n, {
			sanctions: [],
			kycThreshold: THRESHOLD,
			kycApprovals: [alice, bob],
		});

		// Approvals are sticky, so dropping Bob from the list does not revoke his approval. It
		// means the list is incomplete, so the distribution is refused before anything changes.
		await expect(
			db.distribute(period(1), { [alice]: payout("10000") }, 0n, {
				sanctions: [],
				kycThreshold: THRESHOLD,
				kycApprovals: [alice],
			}),
		).rejects.toThrow(`KYC-approved account ${bob} is missing from the approvals`);
		expect(await db.index()).toMatchObject({ tokenTotal: parseSafe("10000") });
	});

	it("refuses when an account approved through `kyc` is missing from the approvals", async () => {
		const root = await createRewardsDirectory();
		const db = new MerkleDb({ root });

		await db.kyc({ toTimestamp: AEGIS_REWARDS_START }, [carol], []);
		await expect(
			db.distribute(period(0), { [alice]: payout("10000") }, 0n, {
				sanctions: [],
				kycThreshold: THRESHOLD,
				kycApprovals: [],
			}),
		).rejects.toThrow(`KYC-approved account ${carol} is missing from the approvals`);
	});
});

describe("kyc update", () => {
	it("releases withheld amounts between distributions", async () => {
		const root = await createRewardsDirectory();
		const db = new MerkleDb({ root });

		await db.distribute(period(0), { [alice]: payout("10000"), [bob]: payout("10000") }, 0n, {
			sanctions: [],
			kycThreshold: THRESHOLD,
			kycApprovals: [],
		});
		const update = await db.kyc(period(0), [alice], []);
		expect(update).toMatchObject({ additionalAmount: 0n, newlyApproved: [alice] });
		expect(update.merkleRoot).not.toBe(zeroHash);
		expect(await readEntry(root, alice)).toMatchObject({
			cumulativeAmount: parseSafe("10000").toString(),
			kycAmount: "0",
			kyc: true,
		});
		expect(await readEntry(root, bob)).toMatchObject({
			cumulativeAmount: "0",
			kycAmount: parseSafe("10000").toString(),
		});

		// Applying the same approvals again changes nothing.
		expect(await db.kyc(period(0), [alice], [])).toEqual({ ...update, newlyApproved: [] });
	});

	it("refuses when a previously approved account is missing from the approvals", async () => {
		const root = await createRewardsDirectory();
		const db = new MerkleDb({ root });

		await db.kyc({ toTimestamp: AEGIS_REWARDS_START }, [alice, bob], []);
		await expect(db.kyc({ toTimestamp: AEGIS_REWARDS_START }, [alice], [])).rejects.toThrow(
			`KYC-approved account ${bob} is missing from the approvals`,
		);
	});

	it("refuses to update a different rewards period", async () => {
		const root = await createRewardsDirectory();
		const db = new MerkleDb({ root });

		await expect(db.kyc(period(0), [alice], [])).rejects.toThrow(
			"attempt to update KYC status for wrong rewards period",
		);
	});
});
