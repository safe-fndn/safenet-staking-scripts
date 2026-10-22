import { parseUnits } from "viem";
import { describe, expect, it } from "vitest";
import {
	CONFIG,
	CUMULATIVE_MERKLE_DROP,
	MERKLE_ROOT,
	PINNED_CID,
	SAFE_TOKEN,
	UPDATE,
} from "../../tests/harness/governance.js";
import { namedAddress } from "../../tests/harness/utils.js";
import { canonicalJson } from "../utils/json.js";
import { IPFS_PARAMETERS } from "./ipfs.js";
import { kyc } from "./kyc.js";
import { type Manifest, zManifest } from "./manifest.js";

const MANIFEST: Manifest = {
	allocations: { forfeited: parseUnits("1000", 18), unpaid: 12225192329728798030n },
	chains: {
		consensus: {
			boundaryBlock: 42_000_000n,
			chainId: 100,
			contracts: {
				consensus: namedAddress("consensus"),
				sentinelOracle: namedAddress("sentinelOracle"),
			},
			settlementBlock: 42_000_048n,
		},
		staking: {
			boundaryBlock: 23_500_000n,
			chainId: 1,
			contracts: {
				delegateRegistry: namedAddress("delegateRegistry"),
				sanctionsList: namedAddress("sanctionsList"),
				staking: namedAddress("staking"),
			},
		},
	},
	distribution: {
		additionalAmount: UPDATE.additionalAmount,
		cumulativeMerkleDrop: CUMULATIVE_MERKLE_DROP,
		merkleRoot: `0x${"42".repeat(32)}`,
		safeToken: SAFE_TOKEN,
		tokenTotal: 4499987774807670271201970n + UPDATE.additionalAmount,
	},
	generator: {
		commit: "f08555f".padEnd(40, "0"),
		repository: "https://github.com/safe-fndn/safenet-staking-scripts",
	},
	governance: CONFIG,
	ipfs: IPFS_PARAMETERS,
	kyc: { newlyApproved: kyc().accounts.slice(0, 2), threshold: kyc().threshold },
	parameters: {
		minPayout: parseUnits("1", 18),
		sentinelRewards: parseUnits("92307.69", 18),
		totalRewards: parseUnits("192307.69", 18),
	},
	period: {
		fromTimestamp: 1791849600n,
		settlementTimestamp: 1793059440n,
		toTimestamp: 1793059200n,
	},
	previous: { cid: PINNED_CID, merkleRoot: MERKLE_ROOT, rewardsUntil: 1791244800n },
	sanctions: {
		offchain: {
			release: "data-2026-10-26",
			repository: "safe-fndn/sanctions-address-lists",
			sha256: {
				"ch-seco": "01".repeat(32),
				eu: "02".repeat(32),
				uk: "03".repeat(32),
				un: "04".repeat(32),
				"us-ofac": "05".repeat(32),
			},
		},
	},
	version: 1,
};

describe("zManifest", () => {
	const json = canonicalJson(MANIFEST);

	it("round-trips through canonical JSON", () => {
		const parsed = zManifest.parse(JSON.parse(json));
		expect(parsed).toEqual(MANIFEST);
		expect(canonicalJson(parsed)).toBe(json);
	});

	it("encodes bigints as decimal strings", () => {
		const raw = JSON.parse(json);
		expect(raw.period.toTimestamp).toBe("1793059200");
		expect(raw.governance.minimumBond).toBe(CONFIG.minimumBond.toString());
		expect(raw.chains.consensus.chainId).toBe(100);
	});

	it("rejects malformed manifests", () => {
		const valid = () => JSON.parse(json);
		const [first, second] = MANIFEST.kyc.newlyApproved;
		const invalid = [
			// Unknown keys, at the top level and nested.
			{ ...valid(), extra: 1 },
			(() => {
				const m = valid();
				m.period.extra = "1";
				return m;
			})(),
			(() => {
				const m = valid();
				m.sanctions.offchain.sha256.extra = "06".repeat(32);
				return m;
			})(),
			// A wrong or missing version.
			{ ...valid(), version: 2 },
			{ ...valid(), version: "1" },
			(() => {
				const { version: _, ...m } = valid();
				return m;
			})(),
			// A non-checksummed address.
			(() => {
				const m = valid();
				m.governance.module = m.governance.module.toLowerCase();
				return m;
			})(),
			// An unsorted or duplicated `newlyApproved`.
			(() => {
				const m = valid();
				m.kyc.newlyApproved = [second, first];
				return m;
			})(),
			(() => {
				const m = valid();
				m.kyc.newlyApproved = [first, first];
				return m;
			})(),
			// Malformed CIDs: CIDv0, base58, and garbage.
			...["QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", "bafy", ""].map((cid) => {
				const m = valid();
				m.previous.cid = cid;
				return m;
			}),
			// A missing offchain sanctions repository, or a missing source hash.
			(() => {
				const m = valid();
				delete m.sanctions.offchain.repository;
				return m;
			})(),
			(() => {
				const m = valid();
				delete m.sanctions.offchain.sha256.un;
				return m;
			})(),
			(() => {
				const m = valid();
				m.sanctions.offchain.release = "latest";
				return m;
			})(),
			// Amounts that are not canonical decimal strings.
			(() => {
				const m = valid();
				m.distribution.additionalAmount = 1;
				return m;
			})(),
			(() => {
				const m = valid();
				m.distribution.tokenTotal = "01";
				return m;
			})(),
			(() => {
				const m = valid();
				m.parameters.minPayout = "-1";
				return m;
			})(),
			// A short commit and an uppercase Merkle root.
			(() => {
				const m = valid();
				m.generator.commit = "f08555f";
				return m;
			})(),
			(() => {
				const m = valid();
				m.distribution.merkleRoot = m.distribution.merkleRoot.toUpperCase();
				return m;
			})(),
		];
		for (const manifest of invalid) {
			expect(zManifest.safeParse(manifest).success, JSON.stringify(manifest)).toBe(false);
		}
	});

	it("requires the fixed IPFS parameters", () => {
		for (const [key, value] of [
			["car", 2],
			["chunker", "size-1048576"],
			["cidVersion", 0],
			["hash", "sha2-512"],
			["layout", "trickle"],
			["rawLeaves", false],
		] as const) {
			const m = JSON.parse(json);
			m.ipfs[key] = value;
			expect(zManifest.safeParse(m).success, key).toBe(false);
		}
	});
});
