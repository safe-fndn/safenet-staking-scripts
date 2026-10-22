/**
 * Mainnet vectors for the Governance Safe transaction, used by
 * `src/distribution/transactions.test.ts`.
 */

import { CID } from "multiformats/cid";
import { type Address, parseUnits, zeroAddress } from "viem";
import type {
	DistributionUpdate,
	GovernanceConfiguration,
} from "../../src/distribution/transactions.js";

// Every vector below was read from Ethereum mainnet at block 26247049 with read-only `eth_call`s
// against the deployed governance contracts:
//
// - the resolver and `contenthash` of `rewards.safenet-gov.eth` from the ENS registry's
//   `resolver(namehash(name))` and the resolver's `contenthash(namehash(name))`;
// - the Merkle root from `CumulativeMerkleDrop.merkleRoot()`, and the SAFE token from
//   `Staking.SAFE_TOKEN()`;
// - the configuration from the Reality Module `0x8DFc…83dC` getters (`avatar()`, `oracle()`,
//   `template()`, `questionArbitrator()`, `questionTimeout()`, `questionCooldown()`,
//   `answerExpiration()`, `minimumBond()`), and the bond token from `oracle.token()`;
// - `OTHER_TX_HASH` and `OTHER_QUESTION_ID` from the module's
//   `getTransactionHash(0x…01, 1, 0x, 1, 7)` and `getQuestionId("hello", 1)`, which cover a value,
//   a delegatecall and nonzero nonces.
//
// At block 26247609, the Governance Safe `0xAd21…ff59` reports `VERSION()` 1.4.1, has no
// transaction guard or module guard set, and `MULTI_SEND_CALL_ONLY` has the runtime code hash
// `0xecd5…9939` that `safe-deployments` lists for the canonical 1.4.1 `MultiSendCallOnly`.
// `execTransactionFromModule(MULTI_SEND_CALL_ONLY, 0, BATCH_DATA, 1)` called on the Safe from the
// Reality Module returns `true`, and the module's
// `getTransactionHash(MULTI_SEND_CALL_ONLY, 0, BATCH_DATA, 1, 0)` is `TX_HASH`. Its
// `buildQuestion(PINNED_CID, [TX_HASH])` is `QUESTION`, and `getQuestionId(QUESTION, 0)` is
// `QUESTION_ID`.
//
// The transactions re-propose the current onchain state with a 172,603.12 SAFE transfer.

export const PINNED_CID = "bafybeiczeo7uiupwte7dfa3yaus6dogwauxbookpvcgmxebbga5jtp7afq";
export const PINNED_CONTENTHASH =
	"0xe301017012205923bf4451f6993e3283780525e1b8d6052e17394fa88ccb9021303a99bfe02c";

export const MODULE: Address = "0x8DFc5Db2C83200Cf0cC84d7e3C441d7721ef83dC";
export const SAFE_TOKEN: Address = "0x5aFE3855358E112B5647B952709E6165e1c1eEEe";
export const CUMULATIVE_MERKLE_DROP: Address = "0xe5139Fc0FB8eae81e30d8a85C22E88c6757120f2";
export const RESOLVER: Address = "0xF29100983E058B709F3D539b0c765937B804AC15";
export const ENS_NAME = "rewards.safenet-gov.eth";
export const ENS_NODE = "0x2ca43be3a22c27d01383e19bcae6429fce3b62edb69123ec3d512c9f5f448491";
export const MERKLE_ROOT = "0x668901980a6c69b801f37cdef375059369dab712db8651a463d1d336b65cfdef";
export const AMOUNT = parseUnits("172603.12", 18);

export const CONFIG: GovernanceConfiguration = {
	answerExpiration: 604800n,
	arbitrator: zeroAddress,
	avatar: "0xAd219b3c26fe42BF5FC66F67490745a4fa5dff59",
	bondToken: SAFE_TOKEN,
	ensName: ENS_NAME,
	ensResolver: RESOLVER,
	minimumBond: parseUnits("10000", 18),
	module: MODULE,
	oracle: "0xdd34D37ABD603658b039BB46f25769E21e252A43",
	questionCooldown: 432000n,
	questionTimeout: 259200n,
	templateId: 6n,
};

export const UPDATE: DistributionUpdate = {
	additionalAmount: AMOUNT,
	cid: CID.parse(PINNED_CID),
	cumulativeMerkleDrop: CUMULATIVE_MERKLE_DROP,
	merkleRoot: MERKLE_ROOT,
	safeToken: SAFE_TOKEN,
};

export const TRANSFER_DATA =
	"0xa9059cbb000000000000000000000000e5139fc0fb8eae81e30d8a85c22e88c6757120f200000000000000000000000000000000000000000000248cd5796d7a19180000";
export const SET_MERKLE_ROOT_DATA =
	"0x7cb64759668901980a6c69b801f37cdef375059369dab712db8651a463d1d336b65cfdef";
export const SET_CONTENTHASH_DATA =
	"0x304e6ade2ca43be3a22c27d01383e19bcae6429fce3b62edb69123ec3d512c9f5f44849100000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000026e301017012205923bf4451f6993e3283780525e1b8d6052e17394fa88ccb9021303a99bfe02c0000000000000000000000000000000000000000000000000000";

export const BATCH_DATA =
	"0x8d80ff0a0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000020b005afe3855358e112b5647b952709e6165e1c1eeee00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000044a9059cbb000000000000000000000000e5139fc0fb8eae81e30d8a85c22e88c6757120f200000000000000000000000000000000000000000000248cd5796d7a1918000000e5139fc0fb8eae81e30d8a85c22e88c6757120f2000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000247cb64759668901980a6c69b801f37cdef375059369dab712db8651a463d1d336b65cfdef00f29100983e058b709f3d539b0c765937b804ac15000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a4304e6ade2ca43be3a22c27d01383e19bcae6429fce3b62edb69123ec3d512c9f5f44849100000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000026e301017012205923bf4451f6993e3283780525e1b8d6052e17394fa88ccb9021303a99bfe02c0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

export const TX_HASH = "0xa7686cf4c2267bbbf49e0c39d9b8e9fc3de1d0113130bd2b8fa79a781353de42";
export const OTHER_TX_HASH = "0x3e089cd52dda6a23342304de204d11b1bfe0c824496da98f45ef8f3eec1f92bc";
export const QUESTION =
	"bafybeiczeo7uiupwte7dfa3yaus6dogwauxbookpvcgmxebbga5jtp7afq\u241fb79314c90e4cc2d42c3ca9e49a65c68f72e94497bf005d2ec04a560b3f8872d1";
export const QUESTION_ID = "0xe19707dd522e3a2f4fb6919e90ea3d336aece7c078708a48420aa79d6724362e";
export const OTHER_QUESTION_ID =
	"0x9fbd8246375e2333be381fdadd92bd2078e777a60ba574b464936ad88fe0e0ab";
