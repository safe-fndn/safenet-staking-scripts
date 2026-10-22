import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GENERATOR_REPOSITORY, generator, headCommit, uncommittedChanges } from "./generator.js";
import { zManifest } from "./manifest.js";

const exec = promisify(execFile);

const temporaries: string[] = [];
const temporary = async (): Promise<string> => {
	const dir = await mkdtemp(join(tmpdir(), "safenet-generator-"));
	temporaries.push(dir);
	return dir;
};
afterEach(async () => {
	await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

// Isolated from the user's and the system's git configuration, such as commit signing.
const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@example.com",
};
const git = async (dir: string, ...args: string[]) =>
	(await exec("git", args, { cwd: dir, env: GIT_ENV })).stdout.trim();

/** A temporary git repository with one commit, a `.gitignore` and a nested directory. */
const repository = async () => {
	const dir = await temporary();
	await git(dir, "init", "--quiet");
	await writeFile(join(dir, "tracked.txt"), "tracked\n");
	await writeFile(join(dir, ".gitignore"), "*.db\n");
	await mkdir(join(dir, "src"));
	await writeFile(join(dir, "src", "code.ts"), "export {};\n");
	await git(dir, "add", ".");
	await git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "initial");
	return { dir, commit: await git(dir, "rev-parse", "HEAD") };
};

const OTHER_COMMIT = "0123456789abcdef0123456789abcdef01234567";

describe("generator", () => {
	it("records the checked-out commit of a clean work tree", async () => {
		const { dir, commit } = await repository();

		expect(await generator({ dir })).toEqual({ commit, repository: GENERATOR_REPOSITORY });
		// Git runs in the work tree containing `dir`, not just at its root.
		expect(await generator({ dir: join(dir, "src") })).toEqual({
			commit,
			repository: GENERATOR_REPOSITORY,
		});
	});

	it("produces a generator block the manifest schema accepts", async () => {
		const { dir } = await repository();
		const block = await generator({ dir });
		expect(zManifest.shape.generator.parse(block)).toEqual(block);
	});

	it("records GIT_COMMIT when it matches the checked-out commit", async () => {
		const { dir, commit } = await repository();
		expect(await generator({ dir, gitCommit: commit })).toEqual({
			commit,
			repository: GENERATOR_REPOSITORY,
		});
	});

	it("refuses a GIT_COMMIT that differs from the checked-out commit", async () => {
		const { dir, commit } = await repository();
		await expect(generator({ dir, gitCommit: OTHER_COMMIT })).rejects.toThrow(
			`GIT_COMMIT ${OTHER_COMMIT} does not match the checked-out commit ${commit}`,
		);
	});

	it("trusts GIT_COMMIT outside a git work tree", async () => {
		const dir = await temporary();
		expect(await generator({ dir, gitCommit: OTHER_COMMIT })).toEqual({
			commit: OTHER_COMMIT,
			repository: GENERATOR_REPOSITORY,
		});
	});

	it("refuses to run outside a git work tree without GIT_COMMIT", async () => {
		const dir = await temporary();
		await expect(generator({ dir })).rejects.toThrow(
			`${dir} is not in a git work tree, and GIT_COMMIT is not set`,
		);
	});

	it.each([
		["an abbreviated hash", OTHER_COMMIT.slice(0, 12)],
		["an uppercase hash", OTHER_COMMIT.toUpperCase()],
		["a 0x-prefixed hash", `0x${OTHER_COMMIT.slice(2)}`],
		["an empty string", ""],
		["a ref", "HEAD"],
	])("refuses %s as GIT_COMMIT", async (_, gitCommit) => {
		const dir = await temporary();
		await expect(generator({ dir, gitCommit })).rejects.toThrow(
			`GIT_COMMIT ${gitCommit} is not a full lowercase git commit hash`,
		);
	});

	it("refuses a modified tracked file", async () => {
		const { dir, commit } = await repository();
		await writeFile(join(dir, "src", "code.ts"), "export const changed = 1;\n");

		await expect(generator({ dir })).rejects.toThrow(
			"refusing to export from a work tree with uncommitted changes:\n M src/code.ts",
		);
		// GIT_COMMIT does not skip the check when there is a work tree.
		await expect(generator({ dir, gitCommit: commit })).rejects.toThrow("uncommitted changes");
	});

	it("refuses a staged change and a deleted tracked file", async () => {
		const { dir } = await repository();
		await writeFile(join(dir, "tracked.txt"), "staged\n");
		await git(dir, "add", "tracked.txt");
		await rm(join(dir, "src", "code.ts"));

		expect(await uncommittedChanges(dir)).toEqual([" D src/code.ts", "M  tracked.txt"]);
		await expect(generator({ dir })).rejects.toThrow("uncommitted changes");
	});

	it("allows untracked and ignored files", async () => {
		const { dir, commit } = await repository();
		await mkdir(join(dir, "out"));
		await writeFile(join(dir, "out", "manifest.json"), "{}\n");
		await writeFile(join(dir, "src", "scratch.ts"), "export {};\n");
		await writeFile(join(dir, "safenet.db"), "");

		expect(await uncommittedChanges(dir)).toEqual([]);
		expect(await generator({ dir })).toEqual({ commit, repository: GENERATOR_REPOSITORY });
	});
});

describe("headCommit", () => {
	it("returns the checked-out commit, or null outside a work tree", async () => {
		const { dir, commit } = await repository();
		expect(await headCommit(dir)).toBe(commit);
		expect(await headCommit(await temporary())).toBeNull();
	});

	it("follows a new commit", async () => {
		const { dir, commit } = await repository();
		await writeFile(join(dir, "tracked.txt"), "changed\n");
		await git(dir, "commit", "--quiet", "--no-gpg-sign", "-am", "change");

		const head = await headCommit(dir);
		expect(head).not.toBe(commit);
		expect(head).toBe(await git(dir, "rev-parse", "HEAD"));
	});

	it("runs in this module's own checkout by default", async () => {
		expect(await headCommit()).toBe(await git(import.meta.dirname, "rev-parse", "HEAD"));
	});
});
