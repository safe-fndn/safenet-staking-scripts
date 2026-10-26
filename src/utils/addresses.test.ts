import type { Address } from "viem";
import { describe, expect, expectTypeOf, it } from "vitest";
import { addressEntries, addressKeys } from "./addresses.js";

const ALICE = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const BOB = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";

describe("addressKeys", () => {
	it("returns checksummed keys as addresses", () => {
		const keys = addressKeys({ [ALICE]: 1n, [BOB]: 2n });
		expectTypeOf(keys).toEqualTypeOf<Address[]>();
		expect(keys).toEqual([ALICE, BOB]);
	});

	it("throws on a lowercase key", () => {
		const key = ALICE.toLowerCase() as Address;
		expect(() => addressKeys({ [key]: 1n })).toThrow(`"${key}" is not a checksummed address`);
	});

	it("throws on a key that is not an address", () => {
		expect(() => addressKeys({ ["0x1234" as Address]: 1n })).toThrow(
			'"0x1234" is not a checksummed address',
		);
	});

	it("returns no keys for an empty record", () => {
		expect(addressKeys({})).toEqual([]);
	});
});

describe("addressEntries", () => {
	it("returns checksummed entries with their values", () => {
		const record: Record<Address, { amount: bigint }> = {
			[ALICE]: { amount: 1n },
			[BOB]: { amount: 2n },
		};
		const entries = addressEntries(record);
		expectTypeOf(entries).toEqualTypeOf<[Address, { amount: bigint }][]>();
		expect(entries).toEqual([
			[ALICE, { amount: 1n }],
			[BOB, { amount: 2n }],
		]);
	});

	it("throws on a lowercase key", () => {
		const key = BOB.toLowerCase() as Address;
		expect(() => addressEntries({ [ALICE]: 1n, [key]: 2n })).toThrow(
			`"${key}" is not a checksummed address`,
		);
	});

	it("throws on a key that is not an address", () => {
		expect(() => addressEntries({ ["not-an-address" as Address]: 1n })).toThrow(
			'"not-an-address" is not a checksummed address',
		);
	});

	it("returns no entries for an empty record", () => {
		expect(addressEntries({})).toEqual([]);
	});
});
