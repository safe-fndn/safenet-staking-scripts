/**
 * Package assembly: the rewards DB that `MerkleDb` distributes into, plus `manifest.json` and
 * `allocations.json`.
 *
 * ```
 * manifest.json
 * allocations.json
 * latest.json
 * proofs/<b0>/<b1>/<b2>/<b3>/<0xaddress>.json
 * ```
 */

import { cp, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, writeJsonFile } from "../utils/json.js";
import { type Allocation, zAllocations } from "./allocations.js";
import { type Manifest, zManifest } from "./manifest.js";

export const MANIFEST_FILE = "manifest.json";
export const ALLOCATIONS_FILE = "allocations.json";
const LATEST_FILE = "latest.json";
const PROOFS_DIR = "proofs";

/**
 * Checks that `dir` holds a rewards DB in the package layout and nothing else: a `latest.json`,
 * an optional `proofs/` tree in the `MerkleDb` layout, and exactly the `extra` files.
 */
const assertLayout = async (
	dir: string,
	extra: { required: string[]; optional: string[] },
): Promise<Set<string>> => {
	const entries = await readdir(dir, { withFileTypes: true });
	const names = new Set(entries.map(({ name }) => name));
	for (const name of [LATEST_FILE, ...extra.required]) {
		if (!names.has(name)) {
			throw new Error(`rewards DB ${JSON.stringify(dir)} has no ${name}`);
		}
	}
	const files = new Set([LATEST_FILE, ...extra.required, ...extra.optional]);
	for (const entry of entries) {
		if (entry.isFile() && files.has(entry.name)) {
			continue;
		}
		if (entry.isDirectory() && entry.name === PROOFS_DIR) {
			await assertProofs(dir, PROOFS_DIR);
			continue;
		}
		throw new Error(`unexpected ${JSON.stringify(join(dir, entry.name))} in rewards DB`);
	}
	return names;
};

/**
 * Checks that a `proofs/` tree holds nothing but `<b0>/<b1>/<b2>/<b3>/<0xaddress>.json` files,
 * where the four directories are the address's leading bytes.
 */
const assertProofs = async (root: string, path: string, prefix = ""): Promise<void> => {
	for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
		const entryPath = join(path, entry.name);
		if (prefix.length < 8) {
			if (entry.isDirectory() && /^[0-9a-f]{2}$/.test(entry.name)) {
				await assertProofs(root, entryPath, prefix + entry.name);
				continue;
			}
		} else if (entry.isFile() && new RegExp(`^0x${prefix}[0-9a-f]{32}\\.json$`).test(entry.name)) {
			continue;
		}
		throw new Error(`unexpected ${JSON.stringify(join(root, entryPath))} in rewards DB`);
	}
};

/**
 * Copies a rewards DB, such as a previous package unpacked by `fetchRewardsDb`, into `dir` so
 * that `MerkleDb` can distribute into it. `manifest.json` and `allocations.json` are left out,
 * as they describe the previous distribution, and the rewards DB pinned at the end of Beta has
 * neither. Anything outside the package layout is refused rather than copied or dropped. `dir` is
 * created if it is missing, and must otherwise be empty.
 */
export const copyRewardsDb = async (from: string, dir: string): Promise<void> => {
	const names = await assertLayout(from, {
		required: [],
		optional: [MANIFEST_FILE, ALLOCATIONS_FILE],
	});
	await mkdir(dir, { recursive: true });
	if ((await readdir(dir)).length > 0) {
		throw new Error(`target directory ${JSON.stringify(dir)} is not empty`);
	}
	for (const name of [LATEST_FILE, PROOFS_DIR].filter((name) => names.has(name))) {
		await cp(join(from, name), join(dir, name), { recursive: true });
	}
};

/**
 * Writes `allocations.json` and `manifest.json` into a rewards DB that `MerkleDb` has just
 * distributed into, completing the package. Both are validated against their schemas first, and
 * the directory must then hold exactly the package layout, so that packing it cannot pick up a
 * leftover `.lock`, a `transactions/` directory or anything else.
 */
export const writePackageFiles = async (
	dir: string,
	{ allocations, manifest }: { allocations: Allocation[]; manifest: Manifest },
): Promise<void> => {
	zAllocations.parse(JSON.parse(canonicalJson(allocations)));
	zManifest.parse(JSON.parse(canonicalJson(manifest)));
	await assertLayout(dir, { required: [], optional: [] });

	await writeJsonFile(join(dir, ALLOCATIONS_FILE), allocations);
	await writeJsonFile(join(dir, MANIFEST_FILE), manifest);
	await assertLayout(dir, { required: [MANIFEST_FILE, ALLOCATIONS_FILE], optional: [] });
};
