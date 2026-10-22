import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CID } from "multiformats/cid";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG, PINNED_CID, UPDATE } from "../../tests/harness/governance.js";
import { MANIFEST } from "../../tests/harness/manifest.js";
import { canonicalJson, writeJsonFile } from "../utils/json.js";
import { actionBundles } from "./actions.js";
import { zManifest } from "./manifest.js";
import { carAssetName, releaseAssets, SHA256SUMS, writeReleaseAssets } from "./release.js";
import { proposal, zProposal } from "./transactions.js";

const exec = promisify(execFile);

const temporaries: string[] = [];
const temporary = async (): Promise<string> => {
	const dir = await mkdtemp(join(tmpdir(), "safenet-release-"));
	temporaries.push(dir);
	return dir;
};
afterEach(async () => {
	await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

// An export of the example manifest. The CAR bytes are arbitrary, as the assets don't depend on
// what they contain.
const buildExport = () => {
	const built = proposal(UPDATE, CONFIG);
	return {
		car: new Uint8Array([0x3a, 0xa2, 0x65, 0x72, 0x6f, 0x6f, 0x74, 0x73]),
		cid: CID.parse(PINNED_CID),
		manifest: MANIFEST,
		proposal: built,
		bundles: actionBundles(built, CONFIG, MANIFEST.period.settlementTimestamp),
	};
};
const EXPORT = buildExport();
const PROPOSAL = EXPORT.proposal;

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("releaseAssets", () => {
	it("contains exactly the release assets, sorted by name", () => {
		expect(carAssetName(1793059200n)).toBe("rewards-1793059200.car");
		expect(Object.keys(releaseAssets(EXPORT))).toEqual([
			"SHA256SUMS",
			"answer.json",
			"cid.txt",
			"execute.json",
			"manifest.json",
			"merkle-root.txt",
			"proposal.json",
			"propose.json",
			"rewards-1793059200.car",
		]);
	});

	it("holds the export's contents", async () => {
		const assets = releaseAssets(EXPORT);

		expect(assets["rewards-1793059200.car"]).toEqual(EXPORT.car);
		expect(decode(assets["cid.txt"])).toBe(`${PINNED_CID}\n`);
		expect(decode(assets["merkle-root.txt"])).toBe(`0x${"42".repeat(32)}\n`);
		expect(decode(assets["manifest.json"])).toBe(canonicalJson(MANIFEST));
		expect(decode(assets["proposal.json"])).toBe(canonicalJson(PROPOSAL));
		for (const name of ["answer", "execute", "propose"] as const) {
			expect(decode(assets[`${name}.json`])).toBe(canonicalJson(EXPORT.bundles[name]));
		}

		// The JSON assets parse back, and are byte-identical to what `writeJsonFile` writes.
		expect(zManifest.parse(JSON.parse(decode(assets["manifest.json"])))).toBeDefined();
		expect(zProposal.parse(JSON.parse(decode(assets["proposal.json"])))).toBeDefined();
		const dir = await temporary();
		await writeJsonFile(join(dir, "manifest.json"), MANIFEST);
		expect(new Uint8Array(await readFile(join(dir, "manifest.json")))).toEqual(
			assets["manifest.json"],
		);
	});

	it("lists every other asset in SHA256SUMS", () => {
		const assets = releaseAssets(EXPORT);

		const expected = Object.keys(assets)
			.filter((name) => name !== SHA256SUMS)
			.map((name) => `${sha256(assets[name])}  ${name}\n`)
			.join("");
		expect(decode(assets[SHA256SUMS])).toBe(expected);
		expect(decode(assets[SHA256SUMS])).not.toContain(SHA256SUMS);
	});

	it("is deterministic", () => {
		const first = releaseAssets(EXPORT);
		const second = releaseAssets(buildExport());
		expect(second).toEqual(first);
	});
});

describe("writeReleaseAssets", () => {
	it("writes the assets, which sha256sum -c accepts", async () => {
		const assets = releaseAssets(EXPORT);
		const dir = join(await temporary(), "release");

		await writeReleaseAssets(dir, assets);

		expect((await readdir(dir)).sort()).toEqual(Object.keys(assets).sort());
		for (const [name, bytes] of Object.entries(assets)) {
			expect(new Uint8Array(await readFile(join(dir, name)))).toEqual(bytes);
		}
		const { stdout } = await exec("sha256sum", ["--check", "--strict", SHA256SUMS], { cwd: dir });
		expect(stdout.trim().split("\n")).toHaveLength(Object.keys(assets).length - 1);
	});

	it("refuses a directory that is not empty", async () => {
		const dir = await temporary();
		await writeFile(join(dir, "cid.txt"), "other\n");

		await expect(writeReleaseAssets(dir, releaseAssets(EXPORT))).rejects.toThrow(
			`release directory ${JSON.stringify(dir)} is not empty`,
		);
		expect(await readFile(join(dir, "cid.txt"), "utf8")).toBe("other\n");
	});
});
