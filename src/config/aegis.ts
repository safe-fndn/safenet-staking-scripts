/**
 * The fixed configuration of the Safenet Aegis deployment.
 *
 * These are the contracts that Aegis rewards are computed from and distributed through. Unlike the
 * RPC URLs or the database file, they are not expected to change, so they are not configuration:
 * the commands always use them. Library functions such as `Safenet.create` still take them as
 * parameters, so that tests can pass their own.
 */

import type { Address } from "viem";
import type { GitHubRepository } from "../utils/gh.js";

/** A contract whose events are indexed, from its deployment block. */
export type IndexedContract = {
	address: Address;
	startBlock: bigint;
};

export type AegisConfiguration = {
	/** Ethereum mainnet: staking, the governance contracts, ENS and the drop. */
	ethereum: {
		staking: IndexedContract;
		/** The delegate registry that validator stakers set commission beneficiaries in. */
		delegateRegistry: IndexedContract;
		/** The Chainalysis sanctions list oracle. */
		sanctionsList: IndexedContract;
		cumulativeMerkleDrop: Address;
		/** The Zodiac Reality Module on the Governance Safe that distributions are proposed to. */
		realityModule: Address;
		/** The ENS name whose `contenthash` pins the latest rewards DB. */
		rewardsEnsName: string;
	};
	/** Gnosis Chain: consensus and the sentinel oracle. */
	gnosis: {
		consensus: IndexedContract;
		sentinelOracle: IndexedContract;
	};
	/** The `owner/name` GitHub repository that publishes the offchain sanctions address lists. */
	sanctionsAddressRepo: GitHubRepository;
};

export const AEGIS: AegisConfiguration = {
	ethereum: {
		staking: {
			address: "0x115E78f160e1E3eF163B05C84562Fa16fA338509",
			startBlock: 24585750n,
		},
		delegateRegistry: {
			address: "0x469788fE6E9E9681C6ebF3bF78e7Fd26Fc015446",
			startBlock: 11225329n,
		},
		sanctionsList: {
			address: "0x40C57923924B5c5c5455c48D93317139ADDaC8fb",
			startBlock: 14356508n,
		},
		cumulativeMerkleDrop: "0xe5139Fc0FB8eae81e30d8a85C22E88c6757120f2",
		realityModule: "0x8DFc5Db2C83200Cf0cC84d7e3C441d7721ef83dC",
		rewardsEnsName: "rewards.safenet-gov.eth",
	},
	gnosis: {
		consensus: {
			address: "0xc855761D619f6002923507cE68B84d7689C2aa96",
			startBlock: 48635843n,
		},
		sentinelOracle: {
			address: "0x4F61B8832978e83b80D69551AEf07557DBE41d03",
			startBlock: 48635850n,
		},
	},
	sanctionsAddressRepo: "safe-fndn/sanctions-address-lists",
};

/**
 * The fixed Aegis values as the parameters of `Safenet.create` and `ExportConfiguration`, which
 * the commands spread over their parsed arguments.
 */
export const AEGIS_PARAMETERS = {
	stakingAddress: AEGIS.ethereum.staking.address,
	stakingStartBlock: AEGIS.ethereum.staking.startBlock,
	delegateRegistryAddress: AEGIS.ethereum.delegateRegistry.address,
	delegateRegistryStartBlock: AEGIS.ethereum.delegateRegistry.startBlock,
	sanctionsListAddress: AEGIS.ethereum.sanctionsList.address,
	sanctionsListStartBlock: AEGIS.ethereum.sanctionsList.startBlock,
	sanctionsAddressRepo: AEGIS.sanctionsAddressRepo,
	consensusAddress: AEGIS.gnosis.consensus.address,
	consensusStartBlock: AEGIS.gnosis.consensus.startBlock,
	sentinelOracleAddress: AEGIS.gnosis.sentinelOracle.address,
	sentinelOracleStartBlock: AEGIS.gnosis.sentinelOracle.startBlock,
	cumulativeMerkleDropAddress: AEGIS.ethereum.cumulativeMerkleDrop,
	realityModuleAddress: AEGIS.ethereum.realityModule,
	rewardsEnsName: AEGIS.ethereum.rewardsEnsName,
};
