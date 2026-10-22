import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { zeroHash } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { MerkleDb } from "../src/merkledb/index.js";
import { AEGIS_REWARDS_START, BETA_REWARDS_UNTIL } from "../src/utils/sep.js";
import { namedAddress, parseSafe } from "./harness/utils.js";

const TWO_WEEKS = BigInt(60 * 60 * 24 * 7 * 2);
const MERKLE_ROOT = `0x${"42".repeat(32)}`;

const roots = [] as string[];

const latestPath = (root: string) => path.join(root, "latest.json");

/**
 * Creates a temporary rewards directory whose `latest.json` holds exactly `contents`, so that tests
 * control the raw on-disk format rather than going through `writeJsonFile`.
 */
const createRewardsDirectory = async (contents: string): Promise<string> => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "safenet-merkledb-"));
	roots.push(root);
	await fs.writeFile(latestPath(root), contents, "utf8");
	return root;
};

const readLatest = async (root: string): Promise<Record<string, unknown>> =>
	JSON.parse(await fs.readFile(latestPath(root), "utf8"));

// A `latest.json` in the format of the currently pinned rewards DB: `jq --tab --sort-keys`
// output, with no `updatedAt`.
const PINNED_LATEST = `{
	"epoch": 0,
	"merkleRoot": "${MERKLE_ROOT}",
	"rewardsUntil": "2026-10-06T00:00:00.000Z",
	"tokenTotal": "${parseSafe("1000")}",
	"unpaidAmount": "${parseSafe("1.5")}"
}
`;

// The first Aegis period, following the Beta → Aegis gap after the pinned rewards DB.
const nextPeriod = {
	fromTimestamp: AEGIS_REWARDS_START,
	toTimestamp: AEGIS_REWARDS_START + TWO_WEEKS,
};

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await fs.rm(root, { recursive: true, force: true });
	}
});

describe("merkledb index", () => {
	it("parses an index without `updatedAt`", async () => {
		const root = await createRewardsDirectory(PINNED_LATEST);
		const index = await new MerkleDb({ root }).index();
		expect(index).toEqual({
			epoch: 0,
			merkleRoot: MERKLE_ROOT,
			tokenTotal: parseSafe("1000"),
			sentinelTokenTotal: 0n,
			unpaidAmount: parseSafe("1.5"),
			rewardsUntil: new Date("2026-10-06T00:00:00.000Z"),
		});
	});

	it("does not write `updatedAt` when distributing", async () => {
		const root = await createRewardsDirectory(PINNED_LATEST);
		const db = new MerkleDb({ root });

		const update = await db.distribute(
			nextPeriod,
			{ [namedAddress("validator")]: { amount: parseSafe("300000"), sentinelAmount: 0n } },
			0n,
			{ sanctions: [], kycApprovals: [] },
		);
		expect(update).not.toBeNull();

		const latest = await readLatest(root);
		expect(latest).not.toHaveProperty("updatedAt");
		expect(latest).toMatchObject({
			epoch: 0,
			rewardsUntil: "2026-10-27T00:00:00.000Z",
			tokenTotal: parseSafe("300000").toString(),
		});
	});

	it("does not write `updatedAt` when updating KYC", async () => {
		const root = await createRewardsDirectory(PINNED_LATEST);
		const db = new MerkleDb({ root });
		const validator = namedAddress("validator");

		await db.distribute(
			nextPeriod,
			{ [validator]: { amount: parseSafe("300000"), sentinelAmount: 0n } },
			0n,
			{ sanctions: [], kycApprovals: [] },
		);
		await db.kyc(nextPeriod, [validator], []);

		const latest = await readLatest(root);
		expect(latest).not.toHaveProperty("updatedAt");
		expect(latest).toMatchObject({ tokenTotal: parseSafe("300000").toString() });
	});

	it("rebuilds an empty tree when nothing is claimable", async () => {
		const root = await createRewardsDirectory(PINNED_LATEST);
		const db = new MerkleDb({ root });
		const validator = namedAddress("validator");

		// The only payout is withheld pending KYC, so the tree has no leaves, but the withheld
		// amount is still funded and counted in the token total. The fixture's 1,000 SAFE total
		// has no entries behind it, so the rebuild replaces it.
		const update = await db.distribute(
			nextPeriod,
			{ [validator]: { amount: parseSafe("300000"), sentinelAmount: 0n } },
			0n,
			{ sanctions: [], kycThreshold: parseSafe("7500"), kycApprovals: [] },
		);
		expect(update).toEqual({
			additionalAmount: parseSafe("299000"),
			merkleRoot: zeroHash,
			newlyApproved: [],
		});

		// A KYC update for an account with no entry creates one with nothing to claim, so the
		// tree stays empty.
		const unknown = namedAddress("unknown");
		const kyc = await db.kyc(nextPeriod, [unknown], []);
		expect(kyc).toEqual({ additionalAmount: 0n, merkleRoot: zeroHash, newlyApproved: [unknown] });
		expect(await db.index()).toMatchObject({
			merkleRoot: zeroHash,
			tokenTotal: parseSafe("300000"),
		});
	});

	it("preserves the unpaid amount when updating KYC", async () => {
		const root = await createRewardsDirectory(PINNED_LATEST);
		const db = new MerkleDb({ root });
		const validator = namedAddress("validator");

		await db.distribute(
			nextPeriod,
			{ [validator]: { amount: parseSafe("300000"), sentinelAmount: 0n } },
			parseSafe("2.5"),
			{ sanctions: [], kycThreshold: parseSafe("7500"), kycApprovals: [] },
		);
		await db.kyc(nextPeriod, [validator], []);

		// The KYC update releases the withheld payout without distributing anything, so the
		// unpaid amount from the period's distribution is kept.
		expect(await db.index()).toMatchObject({
			tokenTotal: parseSafe("300000"),
			unpaidAmount: parseSafe("2.5"),
		});
	});

	it("preserves the pinned unpaid amount when updating KYC", async () => {
		const root = await createRewardsDirectory(PINNED_LATEST);
		const db = new MerkleDb({ root });

		// A KYC update right on top of the pinned index, with no paid entries at all.
		await db.kyc({ toTimestamp: BETA_REWARDS_UNTIL }, [namedAddress("validator")], []);
		expect(await db.index()).toMatchObject({
			merkleRoot: zeroHash,
			unpaidAmount: parseSafe("1.5"),
		});
	});
});
