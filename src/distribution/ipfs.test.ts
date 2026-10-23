import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CarBufferReader } from "@ipld/car";
import * as CarBufferWriter from "@ipld/car/buffer-writer";
import * as dagPb from "@ipld/dag-pb";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { afterEach, describe, expect, it } from "vitest";
import { CHUNK_SIZE, packDirectory, unpackCar } from "./ipfs.js";

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

type Tree = Record<string, string | null>;

/** Every directory (`null`) and file (its hex contents) under `dir`. */
const readTree = async (dir: string): Promise<Tree> => {
	const tree: Tree = {};
	for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
		const path = join(entry.parentPath, entry.name);
		tree[path.slice(dir.length + 1)] = entry.isDirectory()
			? null
			: (await readFile(path)).toString("hex");
	}
	return tree;
};

type Block = { cid: CID; bytes: Uint8Array };

const blocksOf = (car: Uint8Array): Block[] => CarBufferReader.fromBytes(car).blocks();

const writeCar = (roots: CID[], blocks: Block[]): Uint8Array => {
	const size =
		CarBufferWriter.headerLength({ roots }) +
		blocks.reduce((sum, block) => sum + CarBufferWriter.blockLength(block), 0);
	const writer = CarBufferWriter.createWriter(new ArrayBuffer(size), { roots });
	for (const block of blocks) {
		writer.write(block);
	}
	return writer.close();
};

const rawBlock = async (bytes: Uint8Array): Promise<Block> => ({
	cid: CID.createV1(raw.code, await sha256.digest(bytes)),
	bytes,
});

const dagPbBlock = async (node: dagPb.PBNode): Promise<Block> => {
	const bytes = dagPb.encode(dagPb.prepare(node));
	return { cid: CID.createV1(dagPb.code, await sha256.digest(bytes)), bytes };
};

// UnixFS `Data` protobufs: field 1 (`Type`) is 1 for a directory and 4 for a symbolic link,
// whose target is field 2.
const DIRECTORY_DATA = Uint8Array.of(0x08, 0x01);
const symlinkData = (target: string) =>
	Uint8Array.of(0x08, 0x04, 0x12, target.length, ...Buffer.from(target));

/** A CAR of a single directory with the given links. */
const directoryCar = async (
	links: { name: string; block: Block }[],
): Promise<{ cid: CID; car: Uint8Array }> => {
	const dir = await dagPbBlock({
		Data: DIRECTORY_DATA,
		Links: links.map(({ name, block }) => ({
			Hash: block.cid,
			Name: name,
			Tsize: block.bytes.length,
		})),
	});
	return { cid: dir.cid, car: writeCar([dir.cid], [dir, ...links.map(({ block }) => block)]) };
};

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

describe("unpackCar", () => {
	it("round-trips to identical files", async () => {
		const dir = await fixture();
		const { cid, car } = await packDirectory(dir);
		const out = join(await temporary(), "out");
		await unpackCar(car, cid, out);
		expect(await readTree(out)).toEqual(await readTree(dir));
		expect((await packDirectory(out)).cid).toEqual(cid);
	});

	it("unpacks into an existing empty directory", async () => {
		const { cid, car } = await packDirectory(await fixture());
		const out = await temporary();
		await unpackCar(car, cid, out);
		expect(await readFile(join(out, "nested", "a.txt"), "utf-8")).toBe("nested\n");
	});

	it("refuses a non-empty target directory", async () => {
		const { cid, car } = await packDirectory(await fixture());
		const out = await temporary();
		await writeFile(join(out, "stale.json"), "");
		await expect(unpackCar(car, cid, out)).rejects.toThrow("is not empty");
	});

	it("rejects a tampered block and writes nothing", async () => {
		const { cid, car } = await packDirectory(await fixture());
		const blocks = blocksOf(car).map(({ cid, bytes }) => ({ cid, bytes: Uint8Array.from(bytes) }));
		const leaf = blocks.find((block) => block.bytes.length === CHUNK_SIZE) as Block;
		leaf.bytes[0] ^= 1;
		const out = join(await temporary(), "out");
		await expect(unpackCar(writeCar([cid], blocks), cid, out)).rejects.toThrow(
			`CAR block ${leaf.cid} does not match its hash`,
		);
		await expect(readdir(out)).rejects.toThrow("ENOENT");
	});

	it("rejects a different root", async () => {
		const { cid, car } = await packDirectory(await fixture());
		const other = (await packDirectory(await temporary())).cid;
		const out = join(await temporary(), "out");
		await expect(unpackCar(car, other, out)).rejects.toThrow(
			`CAR roots ${cid} do not match expected ${other}`,
		);
		await expect(unpackCar(writeCar([other], blocksOf(car)), cid, out)).rejects.toThrow(
			"do not match expected",
		);
		await expect(unpackCar(writeCar([cid, cid], blocksOf(car)), cid, out)).rejects.toThrow(
			"do not match expected",
		);
	});

	it("rejects a missing block", async () => {
		const { cid, car } = await packDirectory(await fixture());
		const blocks = blocksOf(car);
		const missing = blocks[blocks.length - 1];
		const out = join(await temporary(), "out");
		await expect(unpackCar(writeCar([cid], blocks.slice(0, -1)), cid, out)).rejects.toThrow(
			`CAR is missing block ${missing.cid}`,
		);
		await expect(unpackCar(writeCar([cid], blocks.slice(1)), cid, out)).rejects.toThrow(
			`CAR is missing block ${cid}`,
		);
	});

	it("rejects an unreferenced block", async () => {
		const { cid, car } = await packDirectory(await fixture());
		const extra = await rawBlock(Buffer.from("extra"));
		const out = join(await temporary(), "out");
		await expect(unpackCar(writeCar([cid], [...blocksOf(car), extra]), cid, out)).rejects.toThrow(
			`CAR has 1 unreferenced blocks, such as ${extra.cid}`,
		);
	});

	it("accepts duplicate blocks", async () => {
		const dir = await fixture();
		const { cid, car } = await packDirectory(dir);
		const blocks = blocksOf(car);
		const out = join(await temporary(), "out");
		await unpackCar(writeCar([cid], [...blocks, blocks[1]]), cid, out);
		expect(await readTree(out)).toEqual(await readTree(dir));
	});

	it("rejects unsupported CIDs", async () => {
		const leaf = await rawBlock(Buffer.from("leaf"));
		const v0 = CID.createV0(await sha256.digest(leaf.bytes));
		const { cid, car } = await directoryCar([{ name: "leaf", block: { ...leaf, cid: v0 } }]);
		const out = join(await temporary(), "out");
		await expect(unpackCar(car, cid, out)).rejects.toThrow(`unsupported CID ${v0}`);
	});

	it.each([
		["..", '".."'],
		[".", '"."'],
		[".hidden", '".hidden"'],
		["a/b", '"a/b"'],
		["a\\b", '"a\\\\b"'],
		["", '""'],
	])("rejects the entry name %j", async (name, quoted) => {
		const leaf = await rawBlock(Buffer.from("leaf"));
		const { cid, car } = await directoryCar([{ name, block: leaf }]);
		const out = join(await temporary(), "out");
		await expect(unpackCar(car, cid, out)).rejects.toThrow(`invalid entry name ${quoted}`);
		await expect(readdir(out)).rejects.toThrow("ENOENT");
	});

	it("rejects a nested path traversal", async () => {
		const leaf = await rawBlock(Buffer.from("leaf"));
		const inner = await directoryCar([{ name: "..", block: leaf }]);
		const innerBlocks = blocksOf(inner.car);
		const outer = await dagPbBlock({
			Data: DIRECTORY_DATA,
			Links: [{ Hash: inner.cid, Name: "sub", Tsize: 0 }],
		});
		const car = writeCar([outer.cid], [outer, ...innerBlocks]);
		const out = join(await temporary(), "out");
		await expect(unpackCar(car, outer.cid, out)).rejects.toThrow(
			'invalid entry name ".." in "sub"',
		);
	});

	it("rejects duplicate entry names", async () => {
		const leaf = await rawBlock(Buffer.from("leaf"));
		const { cid, car } = await directoryCar([
			{ name: "leaf", block: leaf },
			{ name: "leaf", block: leaf },
		]);
		const out = join(await temporary(), "out");
		await expect(unpackCar(car, cid, out)).rejects.toThrow('duplicate entry name "leaf"');
	});

	it("rejects symbolic links", async () => {
		const link = await dagPbBlock({ Data: symlinkData("../../etc/passwd"), Links: [] });
		const { cid, car } = await directoryCar([{ name: "link", block: link }]);
		const out = join(await temporary(), "out");
		await expect(unpackCar(car, cid, out)).rejects.toThrow('"link" is an unsupported symlink node');
	});

	// UnixFS `Data` of a directory with field 7 (`mode`) set to 0o777, or field 8 (`mtime`) set to
	// 5 seconds.
	it.each([
		["mode", Uint8Array.of(0x08, 0x01, 0x38, 0xff, 0x03)],
		["mtime", Uint8Array.of(0x08, 0x01, 0x42, 0x02, 0x08, 0x05)],
	])("rejects %s metadata", async (_, data) => {
		const dir = await dagPbBlock({ Data: data, Links: [] });
		const out = join(await temporary(), "out");
		await expect(unpackCar(writeCar([dir.cid], [dir]), dir.cid, out)).rejects.toThrow(
			"has mtime or mode metadata",
		);
	});

	it("rejects a root that is not a directory", async () => {
		const leaf = await rawBlock(Buffer.from("leaf"));
		const out = join(await temporary(), "out");
		await expect(unpackCar(writeCar([leaf.cid], [leaf]), leaf.cid, out)).rejects.toThrow(
			`CAR root ${leaf.cid} is not a directory`,
		);
	});
});
