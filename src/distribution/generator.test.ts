import { describe, expect, it, vi } from "vitest";
import { buildCommit, GENERATOR_REPOSITORY, generator } from "./generator.js";
import { zManifest } from "./manifest.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

const notFound = async () => {
	throw Object.assign(new Error("Cannot find module '../version.js'"), {
		code: "ERR_MODULE_NOT_FOUND",
	});
};

describe("generator", () => {
	it("records the commit of the version module", async () => {
		const warn = vi.fn();

		const block = await generator({ importVersion: async () => ({ GIT_COMMIT: COMMIT }), warn });

		expect(block).toEqual({ commit: COMMIT, repository: GENERATOR_REPOSITORY });
		expect(zManifest.shape.generator.parse(block)).toEqual(block);
		expect(warn).not.toHaveBeenCalled();
	});

	it("records no commit without a version module, with a warning", async () => {
		const warn = vi.fn();

		const block = await generator({ importVersion: notFound, warn });

		expect(block).toEqual({ commit: null, repository: GENERATOR_REPOSITORY });
		expect(zManifest.shape.generator.parse(block)).toEqual(block);
		expect(warn).toHaveBeenCalledExactlyOnceWith(
			"no version module, the code was not built with a commit",
		);
	});

	it("has no version module when running from source", async () => {
		const warn = vi.fn();
		expect(await buildCommit({ warn })).toBeNull();
		expect(warn).toHaveBeenCalledOnce();
	});

	it.each([
		["an empty commit", ""],
		["an abbreviated commit", COMMIT.slice(0, 12)],
		["an uppercase commit", COMMIT.toUpperCase()],
		["a -dirty suffix", `${COMMIT}-dirty`],
		["a -dev suffix", `${COMMIT}-dev`],
		["a bare suffix", "-dirty"],
		["a missing commit", undefined],
		["a number", 42],
	])("refuses a version module with %s", async (_, commit) => {
		await expect(
			generator({ importVersion: async () => ({ GIT_COMMIT: commit }), warn: vi.fn() }),
		).rejects.toThrow(`version module has malformed GIT_COMMIT ${JSON.stringify(commit)}`);
	});

	it("does not swallow other import errors", async () => {
		await expect(
			buildCommit({
				importVersion: async () => {
					throw new SyntaxError("Unexpected token");
				},
			}),
		).rejects.toThrow("Unexpected token");
	});
});
