/**
 * A complete example manifest, shared by `src/distribution/manifest.test.ts` and
 * `src/distribution/package.test.ts`. Its values are realistic but describe no real distribution.
 */

import { parseUnits } from "viem";
import { IPFS_PARAMETERS } from "../../src/distribution/ipfs.js";
import { kyc } from "../../src/distribution/kyc.js";
import type { Manifest } from "../../src/distribution/manifest.js";
import {
	CONFIG,
	CUMULATIVE_MERKLE_DROP,
	MERKLE_ROOT,
	PINNED_CID,
	SAFE_TOKEN,
	UPDATE,
} from "./governance.js";
import { namedAddress } from "./utils.js";

export const MANIFEST: Manifest = {
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
