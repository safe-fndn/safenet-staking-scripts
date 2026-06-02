import { describe, expect, it } from "vitest";
import { createPresenter } from "./presentation.js";

const addr1 = "0x0000000000000000000000000000000000000001";
const addr2 = "0x0000000000000000000000000000000000000002";
const ONE_SAFE = 10n ** 18n;

type Row = { label: string; value: bigint };

const columns = [
	{ header: "Label", width: 42, format: ({ label }: Row) => label },
	{
		header: "Value",
		width: 29,
		align: "right" as const,
		format: ({ value }: Row) => value.toString(),
	},
	{
		header: "Big",
		width: 3,
		format: {
			table: ({ value }: Row) => (value >= ONE_SAFE * 750n ? "*" : ""),
			tsv: ({ value }: Row) => (value >= ONE_SAFE * 750n ? "TRUE" : "FALSE"),
		},
	},
];

const collect = () => {
	const lines: string[] = [];
	return { lines, writer: (line: string) => lines.push(line) };
};

describe("presentTable", () => {
	it("renders header, separators, rows, and footer", () => {
		const { lines, writer } = collect();
		const p = createPresenter<Row>(columns, { writer });
		p.writeRow({ label: addr1, value: ONE_SAFE * 1000n });
		p.finish(["Unpaid", "0.5", ""]);

		expect(lines[0]).toContain("Label");
		expect(lines[0]).toContain("Value");
		expect(lines[1]).toMatch(/^-+\+-+\+-+$/);
		expect(lines[2]).toContain(addr1);
		expect(lines[3]).toMatch(/^-+\+-+\+-+$/);
		expect(lines[4]).toContain("Unpaid");
	});

	it("right-aligns numeric column", () => {
		const { lines, writer } = collect();
		const p = createPresenter<Row>(columns, { writer });
		p.writeRow({ label: addr1, value: ONE_SAFE * 1000n });
		p.finish();

		const valueCol = lines[2].split("|")[1];
		expect(valueCol).toMatch(/^\s+\S+\s$/);
	});

	it("uses table formatter for dual-format columns", () => {
		const { lines, writer } = collect();
		const p = createPresenter<Row>(columns, { writer });
		p.writeRow({ label: addr1, value: ONE_SAFE * 1000n });
		p.writeRow({ label: addr2, value: ONE_SAFE * 500n });
		p.finish();

		expect(lines[2]).toMatch(/\*\s*$/);
		expect(lines[3]).not.toMatch(/\*\s*$/);
	});

	it("omits footer when not provided", () => {
		const { lines, writer } = collect();
		const p = createPresenter<Row>(columns, { writer });
		p.writeRow({ label: addr1, value: ONE_SAFE });
		p.finish();

		expect(lines).toHaveLength(4); // header + sep + row + sep
		expect(lines[3]).toMatch(/^-+/);
	});

	it("throws on repeated finish calls", () => {
		const p = createPresenter<Row>(columns, { writer: () => {} });
		p.finish();
		expect(() => p.finish()).toThrow();
	});

	it("throws on writeRow after finish", () => {
		const p = createPresenter<Row>(columns, { writer: () => {} });
		p.finish();
		expect(() => p.writeRow({ label: addr1, value: ONE_SAFE })).toThrow();
	});
});

describe("presentTsv", () => {
	it("joins rows with tabs, header first, footer last", () => {
		const { lines, writer } = collect();
		const p = createPresenter<Row>(columns, { tsv: true, writer });
		p.writeRow({ label: addr1, value: ONE_SAFE * 500n });
		p.finish(["Unpaid", "0.5", ""]);

		expect(lines[0]).toBe("Label\tValue\tBig");
		expect(lines[1]).toBe(`${addr1}\t${ONE_SAFE * 500n}\tFALSE`);
		expect(lines[2]).toBe("Unpaid\t0.5\t");
	});

	it("uses tsv formatter for dual-format columns", () => {
		const { lines, writer } = collect();
		const p = createPresenter<Row>(columns, { tsv: true, writer });
		p.writeRow({ label: addr1, value: ONE_SAFE * 1000n });
		p.writeRow({ label: addr2, value: ONE_SAFE * 500n });
		p.finish();

		expect(lines[1]).toContain("\tTRUE");
		expect(lines[2]).toContain("\tFALSE");
	});
});
