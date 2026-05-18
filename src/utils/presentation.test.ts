import { describe, expect, it } from "vitest";
import {
	buildRewardsPresentation,
	buildSplitRewardsPresentation,
	presentTable,
	presentTsv,
} from "./presentation.js";

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

describe("buildSplitRewardsPresentation", () => {
	it("builds headers, rows, and footer with stakeRewards and commission columns", () => {
		const payouts = {
			[addr1]: { stakeRewards: ONE_SAFE * 900n, commission: ONE_SAFE * 100n },
			[addr2]: { stakeRewards: ONE_SAFE * 500n, commission: 0n },
		};
		const { headers, rows, footer } = buildSplitRewardsPresentation(payouts, ONE_SAFE / 2n);

		expect(headers).toEqual(["Recipient", "Stake Rewards", "Commission", "KYC"]);
		expect(rows).toEqual([
			[addr1, "900", "100", "FALSE"],
			[addr2, "500", "0", "FALSE"],
		]);
		expect(footer).toEqual(["Unpaid", "0.5", "", ""]);
	});

	it("marks recipients at or above kycThreshold as TRUE based on total", () => {
		const payouts = {
			[addr1]: { stakeRewards: ONE_SAFE * 900n, commission: ONE_SAFE * 100n },
			[addr2]: { stakeRewards: ONE_SAFE * 500n, commission: 0n },
		};
		const { rows } = buildSplitRewardsPresentation(payouts, 0n, ONE_SAFE * 750n);

		expect(rows[0][3]).toBe("TRUE");
		expect(rows[1][3]).toBe("FALSE");
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

	it("renders a split table with stake rewards and commission columns", () => {
		const payouts = {
			[addr1]: { stakeRewards: ONE_SAFE * 900n, commission: ONE_SAFE * 100n },
		};
		const output = presentTable(buildSplitRewardsPresentation(payouts, ONE_SAFE / 2n));
		const lines = output.split("\n");

		expect(lines[0]).toContain("Stake Rewards");
		expect(lines[0]).toContain("Commission");
		expect(lines[1]).toMatch(/^-+/);
		expect(lines[2]).toContain(addr1);
		expect(lines[2]).toContain("900");
		expect(lines[2]).toContain("100");
		expect(lines[3]).toMatch(/^-+/);
		expect(lines[4]).toContain("Unpaid");
	});
});
