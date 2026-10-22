/**
 * The manifest's `generator` block: the commit of this repository a package was built from.
 *
 * The commit comes from the version module, `dist/version.js`, which the Docker image build writes
 * next to the compiled code (see `src/version.d.ts`). Code running from source has none, and its
 * packages record no commit.
 */

import debug from "debug";
import type { Manifest } from "./manifest.js";

/** The repository recorded in every manifest. */
export const GENERATOR_REPOSITORY = "https://github.com/safe-fndn/safenet-staking-scripts";

/** A full, lowercase git commit hash, as the manifest records it. */
export const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/** The manifest's `generator` block. */
export type Generator = Manifest["generator"];

/** Imports the version module. */
export type ImportVersion = () => Promise<{ GIT_COMMIT?: unknown }>;

export type Options = {
	/** Imports the version module, `dist/version.js` by default. */
	importVersion?: ImportVersion;
	/** Reports that there is no version module. */
	warn?: (message: string) => void;
};

const log = debug("safenet:generator");

// Relative to the compiled `dist/distribution/generator.js`.
const importVersionModule: ImportVersion = () => import("../version.js");

/**
 * The commit the running code was built from, from the version module, or `null` with a warning
 * when there is none, as when running from source. A malformed commit means a broken build, so it
 * throws.
 */
export const buildCommit = async ({
	importVersion = importVersionModule,
	warn = log,
}: Options = {}): Promise<string | null> => {
	let version: { GIT_COMMIT?: unknown };
	try {
		version = await importVersion();
	} catch (err) {
		if ((err as { code?: unknown }).code === "ERR_MODULE_NOT_FOUND") {
			warn("no version module, the code was not built with a commit");
			return null;
		}
		throw err;
	}
	const commit = version.GIT_COMMIT;
	if (typeof commit !== "string" || !COMMIT_PATTERN.test(commit)) {
		throw new Error(`version module has malformed GIT_COMMIT ${JSON.stringify(commit)}`);
	}
	return commit;
};

/**
 * The `generator` block of the manifest, with the commit from `buildCommit`.
 */
export const generator = async (options: Options = {}): Promise<Generator> => ({
	commit: await buildCommit(options),
	repository: GENERATOR_REPOSITORY,
});
