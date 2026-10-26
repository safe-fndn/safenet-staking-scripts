import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./json.js";

// A `latest.json` and one proof copied unchanged from the rewards DB pinned at the end of Beta
// (`bafybeiczeo7uiupwte7dfa3yaus6dogwauxbookpvcgmxebbga5jtp7afq`).
const FIXTURE = join(import.meta.dirname, "../../tests/fixtures/canonical");

describe("canonicalJson", () => {
	it("sorts nested object keys", () => {
		expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: 3 } })).toBe(
			'{\n\t"a": {\n\t\t"c": 3,\n\t\t"d": [\n\t\t\t{\n\t\t\t\t"y": 2,\n\t\t\t\t"z": 1\n' +
				'\t\t\t}\n\t\t]\n\t},\n\t"b": 1\n}\n',
		);
	});

	it("sorts keys in string order", () => {
		// Integer-like keys are not moved first as in JavaScript objects.
		const value = { b: 2, B: 3, "9": 4, "10": 5, kycAmount: 6, kyc: 7 };
		expect(canonicalJson(value)).toBe(
			'{\n\t"10": 5,\n\t"9": 4,\n\t"B": 3,\n\t"b": 2,\n\t"kyc": 7,\n\t"kycAmount": 6\n}\n',
		);
	});

	it("preserves array order", () => {
		expect(canonicalJson(["b", "a", 2, 1])).toBe('[\n\t"b",\n\t"a",\n\t2,\n\t1\n]\n');
	});

	it("serializes bigints as decimal strings", () => {
		expect(canonicalJson({ amount: 4499987774807670271201970n, zero: 0n, negative: -1n })).toBe(
			'{\n\t"amount": "4499987774807670271201970",\n\t"negative": "-1",\n\t"zero": "0"\n}\n',
		);
	});

	it("uses tabs and a trailing newline", () => {
		expect(canonicalJson({ a: [1] })).toBe('{\n\t"a": [\n\t\t1\n\t]\n}\n');
		expect(canonicalJson("hello")).toBe('"hello"\n');
		expect(canonicalJson(null)).toBe("null\n");
	});

	it("serializes empty objects and arrays inline", () => {
		expect(canonicalJson({})).toBe("{}\n");
		expect(canonicalJson([])).toBe("[]\n");
		expect(canonicalJson({ a: {}, b: [], c: [{}, []] })).toBe(
			'{\n\t"a": {},\n\t"b": [],\n\t"c": [\n\t\t{},\n\t\t[]\n\t]\n}\n',
		);
	});

	it("converts values like JSON.stringify", () => {
		expect(
			canonicalJson({
				date: new Date("2026-10-06T00:00:00.000Z"),
				missing: undefined,
				list: [undefined],
			}),
		).toBe('{\n\t"date": "2026-10-06T00:00:00.000Z",\n\t"list": [\n\t\tnull\n\t]\n}\n');
		expect(() => canonicalJson(undefined)).toThrow("value cannot be serialized as JSON");
	});

	it("reproduces the pinned rewards DB byte for byte", async () => {
		for (const file of ["latest.json", "0x0484bf598554ab04b9b21421ed28bff6b7742993.json"]) {
			const bytes = await readFile(join(FIXTURE, file), "utf8");
			expect(canonicalJson(JSON.parse(bytes))).toBe(bytes);
		}
	});

	it("reproduces the pinned latest.json from MerkleDb values", async () => {
		// Keys in the insertion order of `IndexData`, with typed values.
		const index = {
			epoch: 0,
			merkleRoot: "0x668901980a6c69b801f37cdef375059369dab712db8651a463d1d336b65cfdef",
			tokenTotal: 4499987774807670271201970n,
			unpaidAmount: 12225192329728798030n,
			rewardsUntil: new Date("2026-10-06T00:00:00.000Z"),
		};
		const bytes = await readFile(join(FIXTURE, "latest.json"), "utf8");
		expect(canonicalJson(index)).toBe(bytes);
	});
});
