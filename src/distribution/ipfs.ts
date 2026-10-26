/**
 * Deterministic IPFS packing of a directory as UnixFS, and verified unpacking of a CARv1.
 *
 * The import parameters are fixed constants: they are Kubo's `ipfs add -r --cid-version=1`
 * defaults, so the CID computed here equals the one Kubo computes for the same directory, and a
 * verifier needs nothing beyond `npm ci`. Changing any of them changes every CID.
 *
 * CAR files are handled as in-memory byte arrays. A rewards package is a few MB at most, every
 * caller has its bytes in memory anyway (a gateway response, a release asset or a local file),
 * and unpacking has to verify the whole DAG before it writes anything.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CarBufferReader } from "@ipld/car";
import * as CarBufferWriter from "@ipld/car/buffer-writer";
import * as dagPb from "@ipld/dag-pb";
import { exporter, type UnixFSEntry } from "ipfs-unixfs-exporter";
import { type ImportCandidate, importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { balanced } from "ipfs-unixfs-importer/layout";
import type { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";

/**
 * The UnixFS import and CAR parameters, in Kubo's terms.
 */
const IPFS_PARAMETERS = {
	car: 1,
	chunker: "size-262144",
	cidVersion: 1,
	hash: "sha2-256",
	layout: "balanced",
	rawLeaves: true,
} as const;

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
 * Checks an entry name, on both packing and unpacking. Besides names that could escape the target
 * directory, hidden names are refused: `ipfs add -r` skips them by default, so a directory that
 * contains one would silently pack to a different CID with Kubo.
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

/**
 * Checks that a CID uses the import parameters: CIDv1, `sha2-256`, and the `dag-pb` or `raw` codec.
 */
const assertCid = (cid: CID): void => {
	if (
		cid.version !== IPFS_PARAMETERS.cidVersion ||
		cid.multihash.code !== sha256.code ||
		(cid.code !== dagPb.code && cid.code !== raw.code)
	) {
		throw new Error(`unsupported CID ${cid}`);
	}
};

type Unpacked = { path: string; content?: Uint8Array };

// `ipfs-unixfs` reports an absent `mode` as the default one, so an explicit default `mode` is
// accepted. It is never applied, and does not change the files.
const DEFAULT_MODES = { directory: 0o755, file: 0o644 };

const assertNoMetadata = (entry: UnixFSEntry & { type: "file" | "directory" }, path: string) => {
	if (entry.unixfs.mtime !== undefined || entry.unixfs.mode !== DEFAULT_MODES[entry.type]) {
		throw new Error(`${JSON.stringify(path)} has mtime or mode metadata`);
	}
};

const concat = async (chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> => {
	const parts: Uint8Array[] = [];
	for await (const chunk of chunks) {
		parts.push(chunk);
	}
	return Buffer.concat(parts);
};

/**
 * Unpacks a CARv1 into `dir`, verifying it completely before writing anything:
 *
 * - its only root must be `expectedCid`, and must be a directory;
 * - every block must use a CIDv1 with `sha2-256` and the `dag-pb` or `raw` codec, and hash to it;
 * - every block that the DAG links to must be present, and every block present must be linked to
 *   (duplicate blocks are harmless, because they hash to the same CID);
 * - every node must be a plain UnixFS file (or a raw leaf) or directory: symbolic links, HAMT
 *   sharded directories, and `mtime` or (non-default) `mode` metadata are refused, like any node
 *   that packing would never produce;
 * - entry names must be safe, so `..`, separators and hidden names are refused, as are duplicate
 *   names within a directory.
 *
 * `dir` is created if it does not exist, and must be empty if it does, so that the result is
 * exactly the CAR's contents. Files are never overwritten.
 */
export const unpackCar = async (car: Uint8Array, expectedCid: CID, dir: string): Promise<void> => {
	const reader = CarBufferReader.fromBytes(car);
	if (reader.version !== IPFS_PARAMETERS.car) {
		throw new Error(`unsupported CAR version ${reader.version}`);
	}
	const roots = reader.getRoots();
	if (roots.length !== 1 || !roots[0].equals(expectedCid)) {
		throw new Error(`CAR roots ${roots.join(", ")} do not match expected ${expectedCid}`);
	}
	assertCid(expectedCid);

	const blocks = new Map<string, Uint8Array>();
	for (const { cid, bytes } of reader.blocks()) {
		assertCid(cid);
		const digest = createHash("sha256").update(bytes).digest();
		if (Buffer.compare(digest, cid.multihash.digest) !== 0) {
			throw new Error(`CAR block ${cid} does not match its hash`);
		}
		blocks.set(cid.toString(), bytes);
	}

	const used = new Set<string>();
	const blockstore = {
		*get(cid: CID) {
			const key = cid.toString();
			const bytes = blocks.get(key);
			if (bytes === undefined) {
				throw new Error(`CAR is missing block ${key}`);
			}
			used.add(key);
			yield bytes;
		},
	};

	const unpacked: Unpacked[] = [];
	const visit = async (cid: CID, path: string, isRoot = false): Promise<void> => {
		assertCid(cid);
		const entry = await exporter(cid, blockstore);
		if (entry.type === "directory" && entry.unixfs.type === "directory") {
			assertNoMetadata(entry, path);
			unpacked.push({ path });
			const names = new Set<string>();
			for await (const child of entry.entries()) {
				assertEntryName(child.name, path);
				if (names.has(child.name)) {
					throw new Error(
						`duplicate entry name ${JSON.stringify(child.name)} in ${JSON.stringify(path)}`,
					);
				}
				names.add(child.name);
				await visit(child.cid, path === "" ? child.name : `${path}/${child.name}`);
			}
		} else if (isRoot) {
			throw new Error(`CAR root ${cid} is not a directory`);
		} else if (entry.type === "file" && entry.unixfs.type === "file") {
			assertNoMetadata(entry, path);
			unpacked.push({ path, content: await concat(entry.content()) });
		} else if (entry.type === "raw") {
			unpacked.push({ path, content: await concat(entry.content()) });
		} else {
			const type = "unixfs" in entry ? entry.unixfs.type : entry.type;
			throw new Error(`${JSON.stringify(path)} is an unsupported ${type} node`);
		}
	};
	await visit(expectedCid, "", true);

	const unused = [...blocks.keys()].filter((key) => !used.has(key));
	if (unused.length > 0) {
		throw new Error(`CAR has ${unused.length} unreferenced blocks, such as ${unused[0]}`);
	}

	await mkdir(dir, { recursive: true });
	if ((await readdir(dir)).length > 0) {
		throw new Error(`target directory ${JSON.stringify(dir)} is not empty`);
	}
	// Directories come before their contents, because the walk is pre-order.
	for (const { path, content } of unpacked) {
		const target = join(dir, path);
		if (content === undefined) {
			await mkdir(target, { recursive: true });
		} else {
			await writeFile(target, content, { flag: "wx" });
		}
	}
};
