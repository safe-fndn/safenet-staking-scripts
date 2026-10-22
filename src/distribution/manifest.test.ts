import { describe, expect, it } from "vitest";
import { CONFIG } from "../../tests/harness/governance.js";
import { MANIFEST } from "../../tests/harness/manifest.js";
import { canonicalJson } from "../utils/json.js";
import { zManifest } from "./manifest.js";

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
