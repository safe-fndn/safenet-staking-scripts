import type { Address, Hex } from "viem";

export type MetaTransaction = {
	safe: Address;
	to: Address;
	value: bigint;
	data: Hex;
	operation: 0 | 1;
};

export type Checker = (meta: MetaTransaction) => boolean;
