import { type Address, getAddress, keccak256, slice, toHex } from "viem";

export const namedAddress = (name: string): Address =>
	getAddress(slice(keccak256(toHex(name)), 12));
