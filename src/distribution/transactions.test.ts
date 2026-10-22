import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { concat, type Hex, stringToHex, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { decodeContenthash, encodeContenthash } from "./transactions.js";

// Read from Ethereum mainnet at block 26247049 with read-only `eth_call`s: the resolver of
// `rewards.safenet-gov.eth` from the ENS registry's `resolver(namehash(name))`, then its
// `contenthash(namehash(name))`.
const PINNED_CID = "bafybeiczeo7uiupwte7dfa3yaus6dogwauxbookpvcgmxebbga5jtp7afq";
const PINNED_CONTENTHASH =
	"0xe301017012205923bf4451f6993e3283780525e1b8d6052e17394fa88ccb9021303a99bfe02c";

describe("contenthash", () => {
	const cid = CID.parse(PINNED_CID);

	it("encodes the pinned CID as its onchain record", () => {
		expect(encodeContenthash(cid)).toBe(PINNED_CONTENTHASH);
	});

	it("decodes the onchain record to the pinned CID", () => {
		expect(decodeContenthash(PINNED_CONTENTHASH).toString()).toBe(PINNED_CID);
		expect(decodeContenthash(PINNED_CONTENTHASH.toUpperCase().replace("0X", "0x") as Hex)).toEqual(
			cid,
		);
	});

	it("round-trips", () => {
		expect(decodeContenthash(encodeContenthash(cid)).equals(cid)).toBe(true);
	});

	it("rejects other namespaces, CIDv0, other CIDs and garbage", () => {
		const cidBytes = toHex(cid.bytes);
		const v0 = cid.toV0();
		const rawCid = CID.createV1(raw.code, cid.multihash);
		const cases: [Hex, RegExp][] = [
			["0x", /not an IPFS contenthash/],
			["0xe3", /not an IPFS contenthash/],
			// ipns-ns and swarm-ns
			[concat(["0xe501", cidBytes]), /not an IPFS contenthash/],
			[concat(["0xe401", cidBytes]), /not an IPFS contenthash/],
			["0xe301", /invalid CID/],
			["0xe30101", /invalid CID/],
			[concat(["0xe301", cidBytes, "0x00"]), /invalid CID/],
			[concat(["0xe301", toHex(v0.bytes)]), /not a CIDv1 sha2-256 dag-pb CID/],
			[concat(["0xe301", toHex(rawCid.bytes)]), /not a CIDv1 sha2-256 dag-pb CID/],
			[stringToHex(PINNED_CID), /not an IPFS contenthash/],
		];
		for (const [contenthash, error] of cases) {
			expect(() => decodeContenthash(contenthash), contenthash).toThrow(error);
		}
	});

	it("refuses to encode anything but a package CID", () => {
		expect(() => encodeContenthash(cid.toV0())).toThrow(/not a CIDv1/);
		expect(() => encodeContenthash(CID.createV1(raw.code, cid.multihash))).toThrow(/not a CIDv1/);
	});
});
