/**
 * The package layout: a rewards DB that `MerkleDb` distributes into, and nothing else.
 *
 * ```
 * latest.json
 * proofs/<b0>/<b1>/<b2>/<b3>/<0xaddress>.json
 * ```
 */

import { cp, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

const LATEST_FILE = "latest.json";
const PROOFS_DIR = "proofs";

/**
 * Checks that `dir` holds a rewards DB in the package layout and nothing else: a `latest.json`
 * and an optional `proofs/` tree in the `MerkleDb` layout.
 */
const assertLayout = async (dir: string): Promise<Set<string>> => {
	const entries = await readdir(dir, { withFileTypes: true });
	const names = new Set(entries.map(({ name }) => name));
	if (!names.has(LATEST_FILE)) {
		throw new Error(`rewards DB ${JSON.stringify(dir)} has no ${LATEST_FILE}`);
	}
	for (const entry of entries) {
		if (entry.isFile() && entry.name === LATEST_FILE) {
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
 * that `MerkleDb` can distribute into it. Anything outside the package layout, such as a `.lock`,
 * a `transactions/` directory or a `manifest.json`, is refused rather than copied or dropped, and
 * the whole layout is checked before `dir` is touched. `dir` is created if it is missing, and must
 * otherwise be empty.
 */
export const copyRewardsDb = async (from: string, dir: string): Promise<void> => {
	const names = await assertLayout(from);
	await mkdir(dir, { recursive: true });
	if ((await readdir(dir)).length > 0) {
		throw new Error(`target directory ${JSON.stringify(dir)} is not empty`);
	}
	for (const name of [LATEST_FILE, PROOFS_DIR].filter((name) => names.has(name))) {
		await cp(join(from, name), join(dir, name), { recursive: true });
	}
};
