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

export const buildSplitRewardsPresentation = (
	payouts: Record<string, { stakeRewards: bigint; commission: bigint }>,
	unpaid: bigint,
	kycThreshold?: bigint,
): Presentation => {
	const meetsKyc = (amount: bigint): boolean => !!kycThreshold && amount >= kycThreshold;
	return {
		headers: ["Recipient", "Stake Rewards", "Commission", "KYC"],
		rows: Object.entries(payouts).map(([recipient, { stakeRewards, commission }]) => [
			recipient,
			formatUnits(stakeRewards, 18),
			formatUnits(commission, 18),
			meetsKyc(stakeRewards + commission) ? "TRUE" : "FALSE",
		]),
		footer: ["Unpaid", formatUnits(unpaid, 18), "", ""],
	};
};

export const presentTsv = ({ headers, rows, footer }: Presentation): string =>
	[headers, ...rows, footer].map((row) => row.join("\t")).join("\n");

export const presentTable = ({ headers, rows, footer }: Presentation): string => {
	const amountCols = headers.length - 2;
	const sep =
		`--------------------------------------------+` +
		`-------------------------------+`.repeat(amountCols) +
		`-----`;
	const fmtRow = (row: string[]) => {
		const [address, ...rest] = row;
		const kyc = rest[rest.length - 1];
		const amounts = rest.slice(0, -1);
		return ` ${address.padEnd(42)} | ${amounts.map((a) => a.padStart(29)).join(" | ")} | ${kyc === "TRUE" ? "*" : kyc}`;
	};
	return [fmtRow(headers), sep, ...rows.map(fmtRow), sep, fmtRow(footer)].join("\n");
};
