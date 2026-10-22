/**
 * Helpers for records keyed by address.
 *
 * Iterating a record with `Object.keys`, `Object.entries` or `for…in` yields
 * `string` keys, losing the `Address` key type. These helpers restore it, and
 * assert that every key is a checksummed address instead of silently
 * normalizing it: a record keyed by a differently cased address would have
 * its entries miss lookups with the checksummed one.
 */

import { type Address, getAddress, isAddress } from "viem";

const checksummed = (key: string): Address => {
	if (!isAddress(key, { strict: false }) || key !== getAddress(key)) {
		throw new Error(`record key ${JSON.stringify(key)} is not a checksummed address`);
	}
	return key;
};

/**
 * Returns the keys of an address-keyed record, asserting that each one is a
 * checksummed address.
 */
export const addressKeys = <T>(record: Record<Address, T>): Address[] =>
	Object.keys(record).map(checksummed);

/**
 * Returns the entries of an address-keyed record, asserting that each key is
 * a checksummed address.
 */
export const addressEntries = <T>(record: Record<Address, T>): [Address, T][] =>
	Object.entries(record).map(([key, value]) => [checksummed(key), value]);
