import { describe, expect, it } from "vitest";
import { buildRewardsPresentation, presentTable, presentTsv } from "./presentation.js";

const addr1 = "0x0000000000000000000000000000000000000001";
const addr2 = "0x0000000000000000000000000000000000000002";
const ONE_SAFE = 10n ** 18n;

describe("buildRewardsPresentation", () => {
	it("builds headers, rows, and footer from payouts", () => {
		const payouts = { [addr1]: ONE_SAFE * 1000n, [addr2]: ONE_SAFE * 500n };
		const { headers, rows, footer } = buildRewardsPresentation(payouts, ONE_SAFE / 2n);

		expect(headers).toEqual(["Recipient", "Payout", "KYC"]);
		expect(rows).toEqual([
			[addr1, "1000", "FALSE"],
			[addr2, "500", "FALSE"],
		]);
		expect(footer).toEqual(["Unpaid", "0.5", ""]);
	});

	it("marks recipients at or above kycThreshold as TRUE", () => {
		const payouts = { [addr1]: ONE_SAFE * 1000n, [addr2]: ONE_SAFE * 500n };
		const { rows } = buildRewardsPresentation(payouts, 0n, ONE_SAFE * 750n);

		expect(rows[0][2]).toBe("TRUE");
		expect(rows[1][2]).toBe("FALSE");
	});
});

describe("presentTsv", () => {
	it("joins all rows with tabs, header first, footer last", () => {
		const payouts = { [addr1]: ONE_SAFE * 1000n };
		const output = presentTsv(buildRewardsPresentation(payouts, ONE_SAFE / 2n));
		const lines = output.split("\n");

		expect(lines[0]).toBe("Recipient\tPayout\tKYC");
		expect(lines[1]).toBe(`${addr1}\t1000\tFALSE`);
		expect(lines[2]).toBe("Unpaid\t0.5\t");
	});
});

describe("presentTable", () => {
	it("renders a table with separators and padded columns", () => {
		const payouts = { [addr1]: ONE_SAFE * 1000n };
		const output = presentTable(buildRewardsPresentation(payouts, ONE_SAFE / 2n));
		const lines = output.split("\n");

		expect(lines[0]).toContain("Recipient");
		expect(lines[1]).toMatch(/^-+/);
		expect(lines[2]).toContain(addr1);
		expect(lines[3]).toMatch(/^-+/);
		expect(lines[4]).toContain("Unpaid");
	});

	it("shows * for KYC-eligible recipients", () => {
		const payouts = { [addr1]: ONE_SAFE * 1000n, [addr2]: ONE_SAFE * 500n };
		const output = presentTable(buildRewardsPresentation(payouts, 0n, ONE_SAFE * 750n));
		const lines = output.split("\n");

		expect(lines[2]).toMatch(/\*\s*$/);
		expect(lines[3]).not.toMatch(/\*\s*$/);
	});
});
