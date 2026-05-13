import { describe, expect, it } from "vitest";
import { formatGsheet } from "./format.js";

const addr1 = "0x0000000000000000000000000000000000000001";
const addr2 = "0x0000000000000000000000000000000000000002";
const ONE_SAFE = 10n ** 18n;

describe("formatGsheet", () => {
	it("outputs tab-separated rows with a header and unpaid footer", () => {
		const payouts = {
			[addr1]: ONE_SAFE * 1000n,
			[addr2]: ONE_SAFE * 500n,
		};
		const output = formatGsheet(payouts, ONE_SAFE / 2n);
		const lines = output.split("\n");

		expect(lines[0]).toBe("Recipient\tPayout\tKYC");
		expect(lines[1]).toBe(`${addr1}\t1000\tFALSE`);
		expect(lines[2]).toBe(`${addr2}\t500\tFALSE`);
		expect(lines[3]).toBe(`Unpaid\t0.5\t`);
	});

	it("marks recipients at or above kycThreshold as TRUE", () => {
		const payouts = {
			[addr1]: ONE_SAFE * 1000n,
			[addr2]: ONE_SAFE * 500n,
		};
		const output = formatGsheet(payouts, 0n, ONE_SAFE * 750n);
		const lines = output.split("\n");

		expect(lines[1]).toBe(`${addr1}\t1000\tTRUE`);
		expect(lines[2]).toBe(`${addr2}\t500\tFALSE`);
	});
});
