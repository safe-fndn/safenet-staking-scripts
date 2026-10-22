/**
 * Resolution of the previous rewards DB, the one a distribution builds on.
 *
 * The previous rewards DB is never chosen by the operator: it is the CID that the ENSIP-7
 * `contenthash` of the rewards ENS name pins, and its `latest.json` Merkle root must equal the
 * root of the Cumulative Merkle Drop. The CAR holding it can come from any source, a local file or
 * an IPFS trustless gateway, because it is verified block by block against that CID.
 */

import { readFile } from "node:fs/promises";
import debug from "debug";
import type { CID } from "multiformats/cid";
import { type Address, type Client, type Hex, namehash, zeroAddress } from "viem";
import { getBlockNumber, readContract } from "viem/actions";
import { CUMULATIVE_MERKLE_DROP_ABI, ENS_REGISTRY_ABI, ENS_RESOLVER_ABI } from "../abi.js";
import { MerkleDb } from "../merkledb/index.js";
import { type Backoff, backoff } from "../utils/backoff.js";
import { dateToTimestamp } from "../utils/ranges.js";
import { packDirectory, unpackCar } from "./ipfs.js";
import { decodeContenthash } from "./transactions.js";

/**
 * The ENS registry, at the same address on every network it is deployed on. It is not
 * configuration: only the ENS name is.
 */
export const ENS_REGISTRY: Address = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";

/**
 * The IPFS trustless gateway CARs are fetched from when `IPFS_GATEWAY_URL` is unset: the gateway
 * of a local Kubo node.
 */
export const DEFAULT_IPFS_GATEWAY_URL = "http://127.0.0.1:8080";

/**
 * The media type of a CARv1 response from a trustless gateway. The CAR version is explicit, as
 * `unpackCar` only reads CARv1. Block order and duplicates are left to the gateway, because
 * unpacking accepts either.
 */
export const CAR_MEDIA_TYPE = "application/vnd.ipld.car; version=1";

/**
 * A rewards DB unpacked into a directory, in the shape of the manifest's `previous` block plus
 * the directory.
 */
export type RewardsDb = {
	/** The package CID, verified against every block of the CAR. */
	cid: CID;
	/** The `merkleRoot` of its `latest.json`. */
	merkleRoot: Hex;
	/** The `rewardsUntil` of its `latest.json`, in seconds. */
	rewardsUntil: bigint;
	/**
	 * The directory it was unpacked into, holding `latest.json` and `proofs/`, as well as
	 * `manifest.json` and `allocations.json` for packages built by the export.
	 */
	dir: string;
};

/**
 * The previous rewards DB, together with the ENS resolver that pins it.
 */
export type PreviousRewardsDb = RewardsDb & {
	/** The resolver of the rewards ENS name, which a distribution sets the new `contenthash` on. */
	ensResolver: Address;
};

/**
 * Where to get a rewards DB's CAR from: a local file if `previousCar` is set, and the
 * `ipfsGatewayUrl` trustless gateway (`DEFAULT_IPFS_GATEWAY_URL` if unset) otherwise.
 */
export type CarSource = {
	previousCar?: string;
	ipfsGatewayUrl?: string;
};

export type Options = {
	/** Retries RPC and gateway requests. */
	withBackoff?: Backoff;
	/** Reports a re-pack CID mismatch, which does not fail the resolution. */
	warn?: (message: string) => void;
};

const log = debug("safenet:previous");
const defaults = (options: Options): Required<Options> => ({
	withBackoff: options.withBackoff ?? backoff({ debug: log }),
	warn: options.warn ?? log,
});

/**
 * Reads the ENS resolver and the package CID that the `contenthash` of `ensName` pins. It throws
 * if the name has no resolver, no `contenthash`, or one that is not a package CID.
 */
export const ensContenthash = async (
	client: Client,
	{ ensName, blockNumber }: { ensName: string; blockNumber?: bigint },
	options: Pick<Options, "withBackoff"> = {},
): Promise<{ cid: CID; ensResolver: Address }> => {
	const { withBackoff } = defaults(options);
	const node = namehash(ensName);
	const ensResolver = await withBackoff(() =>
		readContract(client, {
			address: ENS_REGISTRY,
			abi: ENS_REGISTRY_ABI,
			functionName: "resolver",
			args: [node],
			blockNumber,
		}),
	);
	if (ensResolver === zeroAddress) {
		throw new Error(`ENS name ${ensName} has no resolver`);
	}
	const contenthash = await withBackoff(() =>
		readContract(client, {
			address: ensResolver,
			abi: ENS_RESOLVER_ABI,
			functionName: "contenthash",
			args: [node],
			blockNumber,
		}),
	);
	if (contenthash === "0x") {
		throw new Error(`ENS name ${ensName} has no contenthash`);
	}
	return { cid: decodeContenthash(contenthash), ensResolver };
};

/**
 * The trustless gateway URL of a CID's CAR, `<gateway>/ipfs/<cid>?format=car`.
 */
export const gatewayCarUrl = (ipfsGatewayUrl: string, cid: CID): string =>
	`${ipfsGatewayUrl.replace(/\/+$/, "")}/ipfs/${cid}?format=car`;

/**
 * Gets the CAR of a CID from its source, without verifying it. A gateway request is retried with
 * `withBackoff`, including on a non-OK response, and then thrown.
 */
export const fetchCar = async (
	cid: CID,
	{ previousCar, ipfsGatewayUrl = DEFAULT_IPFS_GATEWAY_URL }: CarSource,
	withBackoff: Backoff,
): Promise<Uint8Array> => {
	if (previousCar !== undefined) {
		return new Uint8Array(await readFile(previousCar));
	}
	const url = gatewayCarUrl(ipfsGatewayUrl, cid);
	return withBackoff(async () => {
		const response = await fetch(url, { headers: { Accept: CAR_MEDIA_TYPE } });
		if (!response.ok) {
			throw new Error(`failed to fetch '${url}': ${response.status} ${response.statusText}`);
		}
		return new Uint8Array(await response.arrayBuffer());
	});
};

/**
 * Gets the rewards DB with a given CID from its source and unpacks it into `dir`, which must be
 * empty or missing. The CAR is verified against `cid` before anything is written.
 *
 * As a self-check of the packing, the unpacked directory is packed again, and a CID that differs
 * is reported with `warn`. That can only happen when the CAR was built with different chunking or
 * layout parameters, so it does not fail.
 */
export const fetchRewardsDb = async (
	cid: CID,
	source: CarSource,
	dir: string,
	options: Options = {},
): Promise<RewardsDb> => {
	const { withBackoff, warn } = defaults(options);
	await unpackCar(await fetchCar(cid, source, withBackoff), cid, dir);

	const index = await new MerkleDb({ root: dir }).index();
	if (index === null) {
		throw new Error(`rewards DB ${cid} has no latest.json`);
	}
	if (index.rewardsUntil === undefined) {
		throw new Error(`rewards DB ${cid} has no rewardsUntil`);
	}

	const repacked = await packDirectory(dir);
	if (!repacked.cid.equals(cid)) {
		warn(`rewards DB ${cid} packs to a different CID ${repacked.cid}`);
	}

	return {
		cid,
		merkleRoot: index.merkleRoot,
		rewardsUntil: dateToTimestamp(index.rewardsUntil),
		dir,
	};
};

/**
 * Resolves the previous rewards DB, the one the `contenthash` of `ensName` pins, and unpacks it
 * into `dir`, which must be empty or missing. Its `latest.json` Merkle root must equal
 * `cumulativeMerkleDrop.merkleRoot()`, otherwise it throws: the two canonical references to the
 * latest rewards DB must agree. Both are read at the same block.
 */
export const resolvePreviousRewardsDb = async (
	client: Client,
	{ ensName, cumulativeMerkleDrop }: { ensName: string; cumulativeMerkleDrop: Address },
	source: CarSource,
	dir: string,
	options: Options = {},
): Promise<PreviousRewardsDb> => {
	const { withBackoff, warn } = defaults(options);
	const blockNumber = await withBackoff(() => getBlockNumber(client, { cacheTime: 0 }));
	const { cid, ensResolver } = await ensContenthash(
		client,
		{ ensName, blockNumber },
		{ withBackoff },
	);
	const merkleRoot = await withBackoff(() =>
		readContract(client, {
			address: cumulativeMerkleDrop,
			abi: CUMULATIVE_MERKLE_DROP_ABI,
			functionName: "merkleRoot",
			blockNumber,
		}),
	);
	log(`${ensName} pins ${cid} at block ${blockNumber}, with Merkle root ${merkleRoot}`);

	const previous = await fetchRewardsDb(cid, source, dir, { withBackoff, warn });
	if (previous.merkleRoot.toLowerCase() !== merkleRoot.toLowerCase()) {
		throw new Error(
			`rewards DB ${cid} pinned by ${ensName} has Merkle root ${previous.merkleRoot}, ` +
				`but CumulativeMerkleDrop ${cumulativeMerkleDrop} has Merkle root ${merkleRoot}`,
		);
	}
	return { ...previous, ensResolver };
};
