/**
 * Deterministic IPFS packing of a directory as UnixFS, into a CARv1.
 *
 * The import parameters are fixed constants: they are Kubo's `ipfs add -r --cid-version=1`
 * defaults, so the CID computed here equals the one Kubo computes for the same directory, and a
 * verifier needs nothing beyond `npm ci`. Changing any of them changes every CID.
 *
 * CAR files are handled as in-memory byte arrays. A rewards package is a few MB at most, and every
 * caller writes or compares its bytes whole.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as CarBufferWriter from "@ipld/car/buffer-writer";
import * as dagPb from "@ipld/dag-pb";
import { type ImportCandidate, importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { balanced } from "ipfs-unixfs-importer/layout";
import type { CID } from "multiformats/cid";

/**
 * The UnixFS import parameters, in the shape of the manifest's `ipfs` block.
 */
export const IPFS_PARAMETERS = {
	car: 1,
	chunker: "size-262144",
	cidVersion: 1,
	hash: "sha2-256",
	layout: "balanced",
	rawLeaves: true,
} as const;

export type IpfsParameters = typeof IPFS_PARAMETERS;

/** Fixed-size chunks of 256 KiB (Kubo's `size-262144`). */
export const CHUNK_SIZE = 262_144;
/** The maximum number of links per node of Kubo's balanced layout. */
export const MAX_CHILDREN_PER_NODE = 174;
/**
 * The directory size from which Kubo shards a directory into a HAMT. Packing never shards, and
 * refuses a directory whose node reaches this size instead, so that it never silently differs
 * from Kubo.
 */
export const HAMT_SHARDING_SIZE = 262_144;

export type Packed = {
	/** The CIDv1 of the directory itself. */
	cid: CID;
	/** A CARv1 with `cid` as its only root, and every block in depth-first link order. */
	car: Uint8Array;
};

// Importer paths need a single top-level directory for the importer to yield its CID. Its name is
// not part of any block, so it does not affect the CID.
const ROOT = "root";

/**
 * Checks an entry name. Besides names that could escape a directory, hidden names are refused:
 * `ipfs add -r` skips them by default, so a directory that contains one would silently pack to a
 * different CID with Kubo.
 */
const assertEntryName = (name: string, path: string): void => {
	if (name === "" || name.startsWith(".") || /[/\\\0]/.test(name)) {
		throw new Error(`invalid entry name ${JSON.stringify(name)} in ${JSON.stringify(path)}`);
	}
};

const compareNames = (a: string, b: string): number =>
	Buffer.compare(Buffer.from(a), Buffer.from(b));

/**
 * Lists the import candidates of a directory: every directory, including empty ones, and every
 * regular file, depth first in byte order of their names. Anything else is refused.
 */
async function* candidates(dir: string, path = ROOT): AsyncGenerator<ImportCandidate> {
	yield { path };
	const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
		compareNames(a.name, b.name),
	);
	for (const entry of entries) {
		assertEntryName(entry.name, dir);
		const [entryPath, file] = [`${path}/${entry.name}`, join(dir, entry.name)];
		if (entry.isDirectory()) {
			yield* candidates(file, entryPath);
		} else if (entry.isFile()) {
			yield { path: entryPath, content: await readFile(file) };
		} else {
			throw new Error(`${JSON.stringify(file)} is not a regular file or directory`);
		}
	}
}

/**
 * Lists the links of a block, in order.
 */
const links = (cid: CID, block: Uint8Array): CID[] =>
	cid.code === dagPb.code ? dagPb.decode(block).Links.map((link) => link.Hash) : [];

/**
 * Packs a directory as UnixFS with the fixed import parameters, and returns its CID and a CAR of
 * it. The same directory always gives the same CID and byte-identical CAR files, whatever the
 * order in which the file system lists it.
 *
 * Only regular files and directories are packed, with no `mtime` or `mode`. Symbolic links, other
 * file types, and hidden names are refused, as is a directory large enough for Kubo to shard.
 */
export const packDirectory = async (dir: string): Promise<Packed> => {
	const blocks = new Map<string, { cid: CID; bytes: Uint8Array }>();
	const blockstore = {
		put: (cid: CID, bytes: Uint8Array) => {
			blocks.set(cid.toString(), { cid, bytes });
			return cid;
		},
	};

	let root: CID | undefined;
	for await (const entry of importer(candidates(dir), blockstore, {
		chunker: fixedSize({ chunkSize: CHUNK_SIZE }),
		cidVersion: IPFS_PARAMETERS.cidVersion,
		layout: balanced({ maxChildrenPerNode: MAX_CHILDREN_PER_NODE }),
		rawLeaves: IPFS_PARAMETERS.rawLeaves,
		reduceSingleLeafToSelf: true,
		shardSplitThresholdBytes: Number.POSITIVE_INFINITY,
		wrapWithDirectory: false,
	})) {
		if (entry.path === ROOT) {
			root = entry.cid;
		}
		if (entry.unixfs?.isDirectory()) {
			const block = blocks.get(entry.cid.toString());
			if (block !== undefined && block.bytes.length >= HAMT_SHARDING_SIZE) {
				throw new Error(`directory ${JSON.stringify(entry.path)} is too large to pack unsharded`);
			}
		}
	}
	if (root === undefined) {
		throw new Error(`no root CID for ${JSON.stringify(dir)}`);
	}

	// Depth-first, pre-order, in link order, with each block only at its first occurrence, as
	// `ipfs dag export` writes it. This does not depend on the order in which the importer, which
	// works concurrently, stored the blocks.
	const ordered: { cid: CID; bytes: Uint8Array }[] = [];
	const seen = new Set<string>();
	const visit = (cid: CID) => {
		const key = cid.toString();
		const block = blocks.get(key);
		if (seen.has(key)) {
			return;
		}
		if (block === undefined) {
			throw new Error(`packing produced no block for ${key}`);
		}
		seen.add(key);
		ordered.push(block);
		for (const link of links(cid, block.bytes)) {
			visit(link);
		}
	};
	visit(root);

	const roots = [root];
	const size =
		CarBufferWriter.headerLength({ roots }) +
		ordered.reduce((sum, block) => sum + CarBufferWriter.blockLength(block), 0);
	const writer = CarBufferWriter.createWriter(new ArrayBuffer(size), { roots });
	for (const block of ordered) {
		writer.write(block);
	}
	return { cid: root, car: writer.close() };
};
