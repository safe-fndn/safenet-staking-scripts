/**
 * The Governance Safe transactions of a distribution.
 *
 * Everything here is a pure function of the distribution, so that the export and `cmd:verify`
 * derive identical values. The package CID is pinned onchain as the ENSIP-7 `contenthash` of the
 * rewards ENS name.
 */

import { CID } from "multiformats/cid";
import { concat, type Hex, hexToBytes, toHex } from "viem";

const DAG_PB = 0x70;
const SHA2_256 = 0x12;
const IPFS_NS = "0xe301";

const assertPackageCid = (cid: CID): void => {
	if (cid.version !== 1 || cid.code !== DAG_PB || cid.multihash.code !== SHA2_256) {
		throw new Error(`CID ${cid} is not a CIDv1 sha2-256 dag-pb CID`);
	}
};

/**
 * Encodes a package CID as an ENSIP-7 `contenthash`: the `ipfs-ns` multicodec (`0xe3 0x01`)
 * followed by the binary CIDv1.
 */
export const encodeContenthash = (cid: CID): Hex => {
	assertPackageCid(cid);
	return concat([IPFS_NS, toHex(cid.bytes)]);
};

/**
 * Decodes an ENSIP-7 `contenthash` that pins a package. It throws for anything other than an
 * `ipfs-ns` CIDv1 sha2-256 dag-pb directory CID with no trailing bytes, including an empty
 * (unset) record and a CIDv0.
 */
export const decodeContenthash = (contenthash: Hex): CID => {
	const bytes = hexToBytes(contenthash);
	if (bytes.length < 2 || bytes[0] !== 0xe3 || bytes[1] !== 0x01) {
		throw new Error(`contenthash ${contenthash} is not an IPFS contenthash`);
	}
	let cid: CID;
	try {
		cid = CID.decode(bytes.subarray(2));
	} catch (err) {
		const message = err instanceof Error ? err.message : "unknown error";
		throw new Error(`contenthash ${contenthash} has an invalid CID: ${message}`);
	}
	assertPackageCid(cid);
	return cid;
};
