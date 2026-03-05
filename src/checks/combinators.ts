import {
	type Address,
	type ContractFunctionName,
	decodeFunctionData,
	type EncodeFunctionDataParameters,
	type ParseAbiItem,
	parseAbiItem,
	slice,
	toFunctionSelector,
} from "viem";
import { decodeMultiSend } from "./multi-send.js";
import type { Checker, MetaTransaction } from "./types.js";

export const exact = (params: Partial<MetaTransaction>): Checker => {
	const fields = Object.entries(params).filter(([, value]) => value !== undefined) as [
		keyof MetaTransaction,
		unknown,
	][];
	return (meta) => fields.every(([key, value]) => meta[key] === value);
};

export const and =
	(...checkers: Checker[]): Checker =>
	(meta) =>
		checkers.every((checker) => checker(meta));
export const or =
	(...checkers: Checker[]): Checker =>
	(meta) =>
		checkers.some((checker) => checker(meta));
export const not =
	(checker: Checker): Checker =>
	(meta) =>
		!checker(meta);

export const always: Checker = () => true;
export const self: Checker = ({ safe, to }) => safe === to;

export type TargetsParameters = { to: Address[] };

export const targets = (...addrs: Address[]): Checker => {
	const allowed = new Set(addrs);
	return ({ to }) => allowed.has(to);
};

export type Args<S extends string> = EncodeFunctionDataParameters<
	[ParseAbiItem<S>],
	ContractFunctionName<[ParseAbiItem<S>]>
>["args"];
type DataParameters<S extends string> = {
	signature: Parameters<typeof parseAbiItem<S>>[0];
	args?: (a: Args<S>, parent: MetaTransaction) => boolean;
};

export const data = <S extends string = string>({
	signature,
	args,
}: DataParameters<S>): Checker => {
	if (args === undefined) {
		const selector = toFunctionSelector(signature as string);
		return ({ data }) => slice(data, 0, 4) === selector;
	} else {
		const abi = [parseAbiItem(signature)];
		return (tx) => {
			try {
				const result = decodeFunctionData({ abi, data: tx.data });
				return args(result.args as Args<S>, tx);
			} catch {
				return false;
			}
		};
	}
};

export const receive = exact({ operation: 0, data: "0x" });

export const call = <S extends string = string>({
	payable,
	...params
}: { payable?: true } & DataParameters<S>): Checker =>
	and(exact({ value: payable ? undefined : 0n, operation: 0 }), data(params));

export const delegatecall = <S extends string = string>(params: DataParameters<S>): Checker =>
	and(exact({ value: 0n, operation: 1 }), data(params));

type MultiSendParameters = {
	to: Address;
	check: Checker;
	version?: "v1.5.0+";
};

export const multisend = ({ to, check, version }: MultiSendParameters): Checker =>
	and(
		targets(to),
		delegatecall({
			signature: "function multiSend(bytes transactions)",
			args: ([transactions], { safe }) =>
				decodeMultiSend({ safe, transactions, version }).every(check),
		}),
	);
