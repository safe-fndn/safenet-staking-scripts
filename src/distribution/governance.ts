/**
 * The governance configuration a distribution is proposed under.
 *
 * Only the Reality Module address and the rewards ENS name are configuration. Everything else is
 * read back from chain: the Governance Safe, the oracle and the question parameters from the
 * module, the bond token from the oracle, and the resolver from the ENS registry. All of it is
 * read at one block, so the configuration is a single onchain state.
 */

import debug from "debug";
import {
	type Address,
	type Client,
	type ContractFunctionName,
	getAddress,
	namehash,
	type ReadContractParameters,
	zeroAddress,
} from "viem";
import { getBlockNumber, readContract } from "viem/actions";
import { ENS_REGISTRY_ABI, REALITY_ETH_ERC20_ABI, REALITY_MODULE_ABI } from "../abi.js";
import { type Backoff, backoff } from "../utils/backoff.js";
import { ENS_REGISTRY } from "./previous.js";
import type { GovernanceConfiguration } from "./transactions.js";

export type Options = {
	/** Retries RPC requests. */
	withBackoff?: Backoff;
};

const log = debug("safenet:governance");

/**
 * Reads the `GovernanceConfiguration` of the Reality Module `module` and the ENS name `ensName`
 * at `blockNumber`, or at the latest block if it is unset.
 *
 * It throws if the module's `avatar` and `target` differ, because the Governance Safe it records
 * would then not be the Safe that executes the proposal, and if `ensName` has no resolver.
 */
export const governanceConfiguration = async (
	client: Client,
	{ module, ensName, blockNumber }: { module: Address; ensName: string; blockNumber?: bigint },
	options: Options = {},
): Promise<GovernanceConfiguration> => {
	const withBackoff = options.withBackoff ?? backoff({ debug: log });
	const block = blockNumber ?? (await withBackoff(() => getBlockNumber(client, { cacheTime: 0 })));
	const address = getAddress(module);
	// Every module getter takes no arguments.
	const read = <F extends ContractFunctionName<typeof REALITY_MODULE_ABI, "view">>(
		functionName: F,
	) =>
		withBackoff(() =>
			readContract(client, {
				address,
				abi: REALITY_MODULE_ABI,
				functionName,
				blockNumber: block,
			} as ReadContractParameters<typeof REALITY_MODULE_ABI, F>),
		);

	const [
		avatar,
		target,
		oracle,
		templateId,
		arbitrator,
		minimumBond,
		questionTimeout,
		questionCooldown,
		answerExpiration,
	] = await Promise.all([
		read("avatar"),
		read("target"),
		read("oracle"),
		read("template"),
		read("questionArbitrator"),
		read("minimumBond"),
		read("questionTimeout"),
		read("questionCooldown"),
		read("answerExpiration"),
	]);
	if (avatar !== target) {
		throw new Error(`Reality Module ${address} has avatar ${avatar} but target ${target}`);
	}
	const [bondToken, ensResolver] = await Promise.all([
		withBackoff(() =>
			readContract(client, {
				address: oracle,
				abi: REALITY_ETH_ERC20_ABI,
				functionName: "token",
				blockNumber: block,
			}),
		),
		withBackoff(() =>
			readContract(client, {
				address: ENS_REGISTRY,
				abi: ENS_REGISTRY_ABI,
				functionName: "resolver",
				args: [namehash(ensName)],
				blockNumber: block,
			}),
		),
	]);
	if (ensResolver === zeroAddress) {
		throw new Error(`ENS name ${ensName} has no resolver`);
	}
	log(`read the governance configuration of ${address} at block ${block}`);

	return {
		answerExpiration: BigInt(answerExpiration),
		arbitrator,
		avatar,
		bondToken,
		ensName,
		ensResolver,
		minimumBond,
		module: address,
		oracle,
		questionCooldown: BigInt(questionCooldown),
		questionTimeout: BigInt(questionTimeout),
		templateId,
	};
};
