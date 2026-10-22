import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Address, getAddress, zeroHash } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { namedAddress, parseSafe } from "../../tests/harness/utils.js";
import { type Filters, MerkleDb } from "../merkledb/index.js";
import { payoutAmount, type RewardSplit } from "../safenet.js";
import { canonicalJson, writeJsonFile } from "../utils/json.js";
import { AEGIS_REWARDS_START } from "../utils/sep.js";
import { sortByAddress } from "../utils/sort.js";
import { type Allocation, buildAllocations, zAllocations } from "./allocations.js";

const TWO_WEEKS = BigInt(60 * 60 * 24 * 7 * 2);
const THRESHOLD = parseSafe("7500");

const [approved, small, unapproved, sanctionedLarge, sanctionedSmall, sentinel] = [
	"approved",
	"small",
	"unapproved",
	"sanctionedLarge",
	"sanctionedSmall",
	"sentinel",
].map(namedAddress);

const split = (stake: string, commission = "0", sentinelRewards = "0"): RewardSplit => ({
	stakeRewards: parseSafe(stake),
	commission: parseSafe(commission),
	sentinelRewards: parseSafe(sentinelRewards),
});

// Inserted in no particular order, with one lowercase key.
const PAYOUTS: Record<Address, RewardSplit> = {
	[sentinel]: split("0", "0", "15384.6"),
	[unapproved]: split("7000", "0", "500"),
	[approved]: split("20000", "1000"),
	[small.toLowerCase() as Address]: split("10", "2"),
	[sanctionedLarge]: split("9000"),
	[sanctionedSmall]: split("5"),
};

const FILTERS: Filters = {
	sanctions: [sanctionedLarge, sanctionedSmall],
	kycThreshold: THRESHOLD,
	kycApprovals: [approved, sentinel],
};

const STATUSES: Record<Address, Allocation["status"]> = {
	[approved]: "paid",
	[small]: "paid",
	[sentinel]: "paid",
	[unapproved]: "kyc-withheld",
	[sanctionedLarge]: "sanctioned",
	[sanctionedSmall]: "sanctioned",
};

const roots = [] as string[];

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await fs.rm(root, { recursive: true, force: true });
	}
});

describe("buildAllocations", () => {
	const { allocations, totals } = buildAllocations(
		{ payouts: PAYOUTS, unpaid: 42n, forfeited: parseSafe("15384.6") },
		FILTERS,
	);

	it("gives each payout its status, sorted by address", () => {
		expect(allocations.map(({ account }) => account)).toEqual(
			sortByAddress(Object.keys(STATUSES) as Address[], (account) => account),
		);
		for (const allocation of allocations) {
			expect(allocation.status, allocation.account).toBe(STATUSES[allocation.account]);
			const { account, status: _, ...rest } = allocation;
			const [, payout] = Object.entries(PAYOUTS).find(([key]) => getAddress(key) === account) ?? [];
			expect(rest).toEqual(payout);
		}
		expect(totals).toEqual({ forfeited: parseSafe("15384.6"), unpaid: 42n });
	});

	it("withholds at exactly the threshold, and nothing without one", () => {
		const payouts = { [unapproved]: split("7000", "500") };
		const at = buildAllocations({ payouts, unpaid: 0n, forfeited: 0n }, FILTERS);
		expect(at.allocations[0].status).toBe("kyc-withheld");

		const below = buildAllocations(
			{ payouts: { [unapproved]: split("7000", "499.99") }, unpaid: 0n, forfeited: 0n },
			FILTERS,
		);
		expect(below.allocations[0].status).toBe("paid");

		const none = buildAllocations(
			{ payouts, unpaid: 0n, forfeited: 0n },
			{ ...FILTERS, kycThreshold: undefined },
		);
		expect(none.allocations[0].status).toBe("paid");
	});

	it("is empty without payouts", () => {
		expect(buildAllocations({ payouts: {}, unpaid: 7n, forfeited: 0n }, FILTERS)).toEqual({
			allocations: [],
			totals: { forfeited: 0n, unpaid: 7n },
		});
	});

	it("matches what MerkleDb.distribute credits", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "safenet-allocations-"));
		roots.push(root);
		await writeJsonFile(path.join(root, "latest.json"), {
			epoch: 0,
			merkleRoot: zeroHash,
			tokenTotal: 0n,
			rewardsUntil: new Date(Number(AEGIS_REWARDS_START) * 1000),
		});
		const db = new MerkleDb({ root });
		const flat = Object.fromEntries(
			// `MerkleDb.distribute` needs checksummed keys, as `Safenet` produces them.
			Object.entries(PAYOUTS).map(([account, split]) => [
				getAddress(account),
				{ amount: payoutAmount(split), sentinelAmount: split.sentinelRewards },
			]),
		);
		const update = await db.distribute(
			{ fromTimestamp: AEGIS_REWARDS_START, toTimestamp: AEGIS_REWARDS_START + TWO_WEEKS },
			flat,
			0n,
			FILTERS,
		);

		// Every allocation is funded, whatever its status.
		expect(update?.additionalAmount).toBe(
			allocations.reduce((sum, allocation) => sum + payoutAmount(allocation), 0n),
		);
		for (const allocation of allocations) {
			const { account, status } = allocation;
			const lower = account.toLowerCase();
			const prefix = [2, 4, 6, 8].map((i) => lower.slice(i, i + 2));
			const file = path.join(root, "proofs", ...prefix, `${lower}.json`);
			const entry = JSON.parse(await fs.readFile(file, "utf8"));
			const amount = payoutAmount(allocation);
			expect(BigInt(entry.sentinelAmount)).toBe(allocation.sentinelRewards);
			expect(BigInt(entry.cumulativeAmount) + BigInt(entry.kycAmount)).toBe(amount);
			if (status === "paid") {
				expect(BigInt(entry.cumulativeAmount)).toBe(amount);
				expect(entry.proof).not.toBeNull();
			} else if (status === "kyc-withheld") {
				expect(BigInt(entry.kycAmount)).toBe(amount);
				expect(entry.proof).toBeNull();
			} else {
				expect(entry.proof).toBeNull();
			}
		}
	});
});

describe("zAllocations", () => {
	const { allocations } = buildAllocations(
		{ payouts: PAYOUTS, unpaid: 0n, forfeited: 0n },
		FILTERS,
	);
	const json = canonicalJson(allocations);

	it("round-trips through canonical JSON", () => {
		const parsed = zAllocations.parse(JSON.parse(json));
		expect(parsed).toEqual(allocations);
		expect(canonicalJson(parsed)).toBe(json);
		expect(JSON.parse(json)[0]).toHaveProperty("commission");
	});

	it("rejects malformed allocations", () => {
		const valid = () => JSON.parse(json);
		const invalid = [
			{},
			(() => {
				const a = valid();
				a[0].extra = "1";
				return a;
			})(),
			(() => {
				const a = valid();
				delete a[0].commission;
				return a;
			})(),
			(() => {
				const a = valid();
				a[0].status = "withheld";
				return a;
			})(),
			(() => {
				const a = valid();
				a[0].account = a[0].account.toLowerCase();
				return a;
			})(),
			(() => {
				const a = valid();
				a[0].stakeRewards = 1;
				return a;
			})(),
			(() => {
				const a = valid();
				a[0].stakeRewards = "-1";
				return a;
			})(),
			(() => {
				const a = valid();
				return [a[1], a[0], ...a.slice(2)];
			})(),
			(() => {
				const a = valid();
				return [a[0], a[0], ...a.slice(1)];
			})(),
		];
		for (const allocations of invalid) {
			expect(zAllocations.safeParse(allocations).success, JSON.stringify(allocations)).toBe(false);
		}
	});
});
