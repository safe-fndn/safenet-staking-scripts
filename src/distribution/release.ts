/**
 * The assets of a distribution's GitHub release: the package CAR, its CID and Merkle root, the
 * proposal, the three action bundles, a copy of the manifest, and `SHA256SUMS` over all of them.
 * They are non-canonical mirrors; the canonical references are the onchain Merkle root and the
 * ENS `contenthash`.
 *
 * The assets are a pure function of an export, so that `cmd:verify` can re-derive them and compare
 * them byte for byte.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../utils/json.js";
import type { Export } from "./export.js";

/** The name of the checksums asset, which covers every other asset. */
export const SHA256SUMS = "SHA256SUMS";

/**
 * The name of the package CAR asset of a period ending at `toTimestamp`, in seconds, which is
 * also the release's tag suffix (`rewards-<toTimestamp>`).
 */
export const carAssetName = (toTimestamp: bigint): string => `rewards-${toTimestamp}.car`;

/** Release assets by name, sorted by name. */
export type ReleaseAssets = Record<string, Uint8Array>;

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/**
 * `SHA256SUMS` in the format `sha256sum` writes and `sha256sum -c` checks: one
 * `<lowercase hex>  <name>` line per asset, two spaces, sorted by name in byte order, with a
 * trailing newline.
 */
export const sha256Sums = (assets: ReleaseAssets): Uint8Array =>
	text(
		Object.keys(assets)
			.sort()
			.map((name) => `${createHash("sha256").update(assets[name]).digest("hex")}  ${name}\n`)
			.join(""),
	);

/**
 * The release assets of an export. JSON assets are canonical JSON, exactly as `writeJsonFile`
 * writes them, and the text assets hold a single line with a trailing newline. `SHA256SUMS` covers
 * every other asset, but not itself.
 */
export const releaseAssets = ({
	car,
	cid,
	manifest,
	proposal,
	bundles,
}: Pick<Export, "car" | "cid" | "manifest" | "proposal" | "bundles">): ReleaseAssets => {
	const assets: ReleaseAssets = {
		[carAssetName(manifest.period.toTimestamp)]: car,
		"answer.json": text(canonicalJson(bundles.answer)),
		"cid.txt": text(`${cid}\n`),
		"execute.json": text(canonicalJson(bundles.execute)),
		"manifest.json": text(canonicalJson(manifest)),
		"merkle-root.txt": text(`${manifest.distribution.merkleRoot}\n`),
		"propose.json": text(canonicalJson(bundles.propose)),
		"proposal.json": text(canonicalJson(proposal)),
	};
	const sums = sha256Sums(assets);
	return Object.fromEntries(
		Object.entries({ ...assets, [SHA256SUMS]: sums }).sort(([a], [b]) => (a < b ? -1 : 1)),
	);
};

/**
 * Writes release assets into `dir`, which is created if it is missing and must otherwise be
 * empty. Files are created with flag `wx`, so nothing is ever overwritten.
 */
export const writeReleaseAssets = async (dir: string, assets: ReleaseAssets): Promise<void> => {
	await mkdir(dir, { recursive: true });
	if ((await readdir(dir)).length > 0) {
		throw new Error(`release directory ${JSON.stringify(dir)} is not empty`);
	}
	for (const [name, bytes] of Object.entries(assets)) {
		await writeFile(join(dir, name), bytes, { flag: "wx" });
	}
};
