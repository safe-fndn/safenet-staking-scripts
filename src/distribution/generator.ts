/**
 * The manifest's `generator` block: the commit of this repository a package was built from.
 *
 * Matching bytes are only guaranteed for the same commit, so the export refuses to run from a
 * checkout with uncommitted changes to tracked files. Untracked files are allowed, because the
 * export's own outputs and databases are untracked, and committed code cannot import them.
 */

import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Manifest } from "./manifest.js";

/** The repository recorded in every manifest. */
export const GENERATOR_REPOSITORY = "https://github.com/safe-fndn/safenet-staking-scripts";

/** A full, lowercase git commit hash, as the manifest records it. */
export const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/**
 * The directory of this module, which is inside the checkout the code runs from, both as `src/`
 * and as `dist/`. Git is run there rather than in the working directory, so that it inspects the
 * code that builds the package, wherever the command is run from.
 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** The manifest's `generator` block. */
export type Generator = Manifest["generator"];

const exec = promisify(execFile);

const git = async (dir: string, args: string[]): Promise<string> =>
	(await exec("git", args, { cwd: dir, encoding: "utf8" })).stdout.trimEnd();

/**
 * The commit checked out in the git work tree containing `dir`, or `null` if `dir` is not in a
 * git work tree or git is not installed (as in the Docker image).
 */
export const headCommit = async (dir: string = MODULE_DIR): Promise<string | null> => {
	try {
		if ((await git(dir, ["rev-parse", "--is-inside-work-tree"])) !== "true") {
			return null;
		}
	} catch {
		return null;
	}
	return git(dir, ["rev-parse", "--verify", "HEAD"]);
};

/**
 * The tracked files with uncommitted changes, staged or not, in the git work tree containing
 * `dir`, as `git status --porcelain` lines. Untracked and ignored files are not included.
 */
export const uncommittedChanges = async (dir: string = MODULE_DIR): Promise<string[]> => {
	const status = await git(dir, ["status", "--porcelain", "--untracked-files=no"]);
	return status === "" ? [] : status.split("\n");
};

/**
 * The `generator` block of the manifest.
 *
 * The commit is `gitCommit` (the `GIT_COMMIT` variable) when it is set, and the checked-out commit
 * of the work tree containing `dir` otherwise. When there is a work tree, its `HEAD` must equal
 * `gitCommit` if that is set, and it must have no uncommitted changes to tracked files. Without a
 * work tree, as in the Docker image, which has neither `.git` nor git, `gitCommit` is required and
 * is trusted as is: the image was built from that commit.
 */
export const generator = async ({
	gitCommit,
	dir = MODULE_DIR,
}: {
	gitCommit?: string;
	dir?: string;
} = {}): Promise<Generator> => {
	if (gitCommit !== undefined && !COMMIT_PATTERN.test(gitCommit)) {
		throw new Error(`GIT_COMMIT ${gitCommit} is not a full lowercase git commit hash`);
	}
	const head = await headCommit(dir);
	if (head === null) {
		if (gitCommit === undefined) {
			throw new Error(`${dir} is not in a git work tree, and GIT_COMMIT is not set`);
		}
		return { commit: gitCommit, repository: GENERATOR_REPOSITORY };
	}
	if (gitCommit !== undefined && gitCommit !== head) {
		throw new Error(`GIT_COMMIT ${gitCommit} does not match the checked-out commit ${head}`);
	}
	const changes = await uncommittedChanges(dir);
	if (changes.length > 0) {
		throw new Error(
			`refusing to export from a work tree with uncommitted changes:\n${changes.join("\n")}`,
		);
	}
	return { commit: head, repository: GENERATOR_REPOSITORY };
};
