import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CarBufferReader } from "@ipld/car";
import * as dagPb from "@ipld/dag-pb";
import type { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { afterEach, describe, expect, it } from "vitest";
import { CHUNK_SIZE, IPFS_PARAMETERS, packDirectory } from "./ipfs.js";

const FIXTURE = join(import.meta.dirname, "../../tests/fixtures/ipfs");

// Computed with Kubo 0.43.1 (`ipfs version --all`: 0.43.1-acc53c093), on a copy of the fixture
// built by `fixture()` below, in a throwaway repository:
//
//   export IPFS_PATH=<scratch>/ipfs && ipfs init -e
//   ipfs add -r --cid-version=1 -Q --offline <fixture>
//   ipfs dag export --offline <cid> | sha256sum
const KUBO_CID = "bafybeiai2sumgej3eol4k2cmnfsbrozuxscrg35r4w7hzyhp76tu4ecfdi";
const KUBO_CAR_SHA256 = "f713b80747a660646a3d62c69a23ef9e8ff015ae277720d4722eff7d54712d79";
// The raw-leaf CID of an empty file, as reported by the same `ipfs add`.
const EMPTY_FILE_CID = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

// Three chunks, the last one partial. `i % 251` keeps the chunks distinct.
const LARGE_FILE_SIZE = 2 * CHUNK_SIZE + 1000;
const largeFile = () => Uint8Array.from({ length: LARGE_FILE_SIZE }, (_, i) => i % 251);

const temporaries: string[] = [];
const temporary = async (): Promise<string> => {
	const dir = await mkdtemp(join(tmpdir(), "safenet-ipfs-"));
	temporaries.push(dir);
	return dir;
};
afterEach(async () => {
	await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

/**
 * The committed fixture, plus what git cannot hold or should not: an empty directory and a file
 * larger than one chunk.
 */
const fixture = async (): Promise<string> => {
	const dir = join(await temporary(), "fixture");
	await cp(FIXTURE, dir, { recursive: true });
	await mkdir(join(dir, "empty-dir"));
	await writeFile(join(dir, "large.bin"), largeFile());
	return dir;
};

describe("IPFS_PARAMETERS", () => {
	it("matches the manifest's ipfs block", () => {
		expect(IPFS_PARAMETERS).toEqual({
			car: 1,
			chunker: "size-262144",
			cidVersion: 1,
			hash: "sha2-256",
			layout: "balanced",
			rawLeaves: true,
		});
	});
});

describe("packDirectory", () => {
	it("computes the same CID and CAR as Kubo", async () => {
		const { cid, car } = await packDirectory(await fixture());
		expect(cid.toString()).toBe(KUBO_CID);
		expect(createHash("sha256").update(car).digest("hex")).toBe(KUBO_CAR_SHA256);
	});

	it("writes a CARv1 with the directory as its only root", async () => {
		const { cid, car } = await packDirectory(await fixture());
		const reader = CarBufferReader.fromBytes(car);
		expect(reader.version).toBe(1);
		expect(reader.getRoots()).toEqual([cid]);
		expect(reader.blocks()[0].cid).toEqual(cid);
	});

	it("packs a small file as a raw leaf whose CID is its SHA-256", async () => {
		const dir = await fixture();
		const { cid, car } = await packDirectory(dir);
		const digest = createHash("sha256")
			.update(await readFile(join(dir, "hello.json")))
			.digest();
		const reader = CarBufferReader.fromBytes(car);
		const root = dagPb.decode(reader.get(cid)?.bytes ?? new Uint8Array());
		const link = root.Links.find((l) => l.Name === "hello.json");
		expect(link?.Hash.code).toBe(raw.code);
		expect(Buffer.from(link?.Hash.multihash.digest ?? [])).toEqual(digest);
		expect(root.Links.find((l) => l.Name === "empty")?.Hash.toString()).toBe(EMPTY_FILE_CID);
	});

	it("chunks a large file into 256 KiB raw leaves", async () => {
		const { cid, car } = await packDirectory(await fixture());
		const reader = CarBufferReader.fromBytes(car);
		const root = dagPb.decode(reader.get(cid)?.bytes ?? new Uint8Array());
		const link = root.Links.find((l) => l.Name === "large.bin");
		expect(link?.Hash.code).toBe(dagPb.code);
		const file = dagPb.decode(reader.get(link?.Hash as CID)?.bytes ?? new Uint8Array());
		const leaves = file.Links.map((l) => reader.get(l.Hash));
		expect(leaves.map((leaf) => leaf?.cid.code)).toEqual([raw.code, raw.code, raw.code]);
		expect(leaves.map((leaf) => leaf?.bytes.length)).toEqual([CHUNK_SIZE, CHUNK_SIZE, 1000]);
	});

	it("is deterministic", async () => {
		const dir = await fixture();
		const first = await packDirectory(dir);
		const second = await packDirectory(dir);
		expect(second.cid).toEqual(first.cid);
		expect(Buffer.from(second.car)).toEqual(Buffer.from(first.car));
	});

	it("does not depend on the order in which files are created", async () => {
		const forwards = await temporary();
		const backwards = await temporary();
		const names = Array.from({ length: 50 }, (_, i) => `file-${i}.json`);
		for (const name of names) {
			await writeFile(join(forwards, name), name);
		}
		for (const name of names.reverse()) {
			await writeFile(join(backwards, name), name);
		}
		const a = await packDirectory(forwards);
		const b = await packDirectory(backwards);
		expect(b.cid).toEqual(a.cid);
		expect(Buffer.from(b.car)).toEqual(Buffer.from(a.car));
	});

	it("refuses a directory large enough for Kubo to shard", async () => {
		const dir = await temporary();
		for (let i = 0; i < 2000; i++) {
			await writeFile(join(dir, `${i}`.padStart(100, "x")), "");
		}
		await expect(packDirectory(dir)).rejects.toThrow("is too large to pack unsharded");
	});

	it("refuses symbolic links", async () => {
		const dir = await fixture();
		await symlink("hello.json", join(dir, "link.json"));
		await expect(packDirectory(dir)).rejects.toThrow("is not a regular file or directory");
	});

	it("refuses hidden names", async () => {
		const dir = await fixture();
		await writeFile(join(dir, "nested", ".lock"), "");
		await expect(packDirectory(dir)).rejects.toThrow('invalid entry name ".lock"');
	});
});
