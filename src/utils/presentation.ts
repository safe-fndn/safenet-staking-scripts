import { type Address, formatUnits } from "viem";
import { formatSafeToken } from "./format.js";

type FormatFn<T> = (item: T) => string;

export type ColumnDef<T> = {
	header: string;
	width: number;
	align?: "left" | "right";
	format: FormatFn<T> | { table: FormatFn<T>; tsv: FormatFn<T> };
};

export type Presenter<T> = {
	writeRow: (item: T) => void;
	finish: (footer?: string[]) => void;
};

const resolveFormat = <T>(col: ColumnDef<T>, mode: "table" | "tsv"): FormatFn<T> =>
	typeof col.format === "function" ? col.format : col.format[mode];

export const createPresenter = <T>(
	columns: ColumnDef<T>[],
	{ tsv = false, writer = console.log }: { tsv?: boolean; writer?: (line: string) => void } = {},
): Presenter<T> => {
	const mode = tsv ? "tsv" : "table";
	let finished = false;

	const tableSeparator = columns.map((col) => "-".repeat(col.width + 2)).join("+");

	const fmtTsvLine = (values: string[]) => columns.map((_, i) => values[i] ?? "").join("\t");
	const fmtTableLine = (values: string[]) => {
		const padCell = (col: ColumnDef<T>, value: string) =>
			col.align === "right" ? ` ${value.padStart(col.width)} ` : ` ${value.padEnd(col.width)} `;
		return columns.map((col, i) => padCell(col, values[i] ?? "")).join("|");
	};
	const fmtLine = mode === "tsv" ? fmtTsvLine : fmtTableLine;

	writer(fmtLine(columns.map((col) => col.header)));
	if (mode === "table") writer(tableSeparator);

	const writeRow = (item: T): void => {
		if (finished) throw new Error("Presenter already finished");
		writer(fmtLine(columns.map((col) => resolveFormat(col, mode)(item))));
	};

	const finish = (footer?: string[]): void => {
		if (finished) throw new Error("Presenter already finished");
		finished = true;

		if (mode === "table") writer(tableSeparator);
		if (footer) writer(fmtLine(footer));
	};

	return { writeRow, finish };
};

/**
 * Column helper for Ethereum addresses. Sets the width to fit a checksummed
 * address (`0x` plus 40 hex characters) and renders the {@link Address}
 * returned by `extract`.
 */
export const addressColumn = <T>({
	header,
	extract,
}: {
	header: string;
	extract: (item: T) => Address;
}): ColumnDef<T> => ({
	header,
	width: 42,
	format: extract,
});

/**
 * Column helper for SAFE token amounts. Renders the `bigint` returned by
 * `extract` using {@link formatSafeToken} in table mode (fixed 29-character
 * width: 10 integer digits, `.`, and 18 fractional digits) and a plain
 * `formatUnits` representation in TSV mode.
 */
export const safeTokenColumn = <T>({
	header,
	extract,
}: {
	header: string;
	extract: (item: T) => bigint;
}): ColumnDef<T> => ({
	header,
	width: 29,
	format: {
		table: (item) => formatSafeToken(extract(item)),
		tsv: (item) => formatUnits(extract(item), 18),
	},
});
