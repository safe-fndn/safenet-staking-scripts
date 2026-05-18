import { formatUnits } from "viem";

export type Presentation = {
	headers: string[];
	rows: string[][];
	footer: string[];
};

export const buildRewardsPresentation = (
	payouts: Record<string, bigint>,
	unpaid: bigint,
	kycThreshold?: bigint,
): Presentation => {
	const meetsKyc = (amount: bigint): boolean => !!kycThreshold && amount >= kycThreshold;
	return {
		headers: ["Recipient", "Payout", "KYC"],
		rows: Object.entries(payouts).map(([recipient, amount]) => [
			recipient,
			formatUnits(amount, 18),
			meetsKyc(amount) ? "TRUE" : "FALSE",
		]),
		footer: ["Unpaid", formatUnits(unpaid, 18), ""],
	};
};

export const presentTsv = ({ headers, rows, footer }: Presentation): string =>
	[headers, ...rows, footer].map((row) => row.join("\t")).join("\n");

export const presentTable = ({ headers, rows, footer }: Presentation): string => {
	const sep = `--------------------------------------------+-------------------------------+-----`;
	const fmtRow = ([col0, col1, col2]: string[]) =>
		` ${col0.padEnd(42)} | ${col1.padStart(29)} | ${col2 === "TRUE" ? "*" : col2}`;
	return [fmtRow(headers), sep, ...rows.map(fmtRow), sep, fmtRow(footer)].join("\n");
};
