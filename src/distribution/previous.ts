/**
 * Fetching of a rewards DB by its CID.
 *
 * The CAR holding a rewards DB can come from any source, a local file or an IPFS trustless
 * gateway, because it is verified block by block against the CID before anything is written.
 */

import { readFile } from "node:fs/promises";
import debug from "debug";
import type { CID } from "multiformats/cid";
import type { Hex } from "viem";
import { MerkleDb } from "../merkledb/index.js";
import { type Backoff, backoff } from "../utils/backoff.js";
import { dateToTimestamp } from "../utils/ranges.js";
import { packDirectory, unpackCar } from "./ipfs.js";

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
 * Where to get a rewards DB's CAR from: a local file if `previousCar` is set, and the
 * `ipfsGatewayUrl` trustless gateway (`DEFAULT_IPFS_GATEWAY_URL` if unset) otherwise.
 */
export type CarSource = {
	previousCar?: string;
	ipfsGatewayUrl?: string;
};

export type Options = {
	/** Retries gateway requests. */
	withBackoff?: Backoff;
	/** Reports a re-pack CID mismatch, which does not fail the fetch. */
	warn?: (message: string) => void;
};

const log = debug("safenet:previous");
const defaults = (options: Options): Required<Options> => ({
	withBackoff: options.withBackoff ?? backoff({ debug: log }),
	warn: options.warn ?? log,
});

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
