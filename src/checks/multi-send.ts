import { type Address, getAddress, type Hex, size, slice, zeroAddress } from "viem";
import type { MetaTransaction } from "./types.js";

const makeCursor = (data: Hex) => {
	let i = 0;
	return {
		get empty(): boolean {
			return i >= size(data);
		},
		read(len: number): Hex {
			// Viem doesn't like reading 0-length slices at the end of bytes in
			// strict mode, so handle that case manually.
			if (len === 0 && i <= size(data)) {
				return "0x";
			} else {
				const result = slice(data, i, i + len, { strict: true });
				i += len;
				return result;
			}
		},
	};
};

const addressOrSelf = (addr: Address, self: Address) => (addr !== zeroAddress ? addr : self);

export const decodeMultiSend = ({
	safe,
	transactions,
	version,
}: {
	safe: Address;
	transactions: Hex;
	version?: "v1.5.0+";
}): MetaTransaction[] => {
	const result = [] as MetaTransaction[];
	const cursor = makeCursor(transactions);
	while (!cursor.empty) {
		const operation = Number(cursor.read(1));
		if (operation !== 0 && operation !== 1) {
			throw new Error(`invalid multi-send operation ${operation}`);
		}
		// Using `to` as the zero-address to indicate a self-call was added in
		// Safe v1.5.0. This means that not all multi-send contracts support it
		// and our decoder needs to handle both cases.
		const to =
			version === "v1.5.0+"
				? addressOrSelf(getAddress(cursor.read(20)), safe)
				: getAddress(cursor.read(20));
		const value = BigInt(cursor.read(32));
		const dataLength = Number(cursor.read(32));
		const data = cursor.read(dataLength);
		result.push({
			safe,
			to,
			value,
			data,
			operation,
		});
	}
	return result;
};
