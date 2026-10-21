import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type BundleTransaction, transactionBundle, writeTransactionBundle } from "./bundle.js";

const to = "0x0000000000000000000000000000000000000001" as const;

describe("transactionBundle", () => {
	it.concurrent("is a pure function of its transactions and creation time", () => {
		const transactions: BundleTransaction[] = [
			{ to, data: "0x01" },
			{
				to,
				value: "42",
				contractMethod: { inputs: [], name: "foo", payable: true },
				contractInputsValues: {},
			},
		];
		const bundle = transactionBundle(transactions, 1337);
		expect(bundle).toEqual({
			version: "1.0",
			chainId: "1",
			createdAt: 1337,
			meta: {},
			transactions: [
				{ to, value: "0", data: "0x01", contractMethod: null, contractInputsValues: null },
				{
					to,
					value: "42",
					data: null,
					contractMethod: { inputs: [], name: "foo", payable: true },
					contractInputsValues: {},
				},
			],
		});
		expect(transactionBundle(transactions, 1337)).toEqual(bundle);
	});
});

describe("writeTransactionBundle", () => {
	it("writes the bundle to the given directory at the current time", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-"));
		try {
			vi.useFakeTimers({ now: 1337 });
			const dir = path.join(tmp, "transactions");
			const file = await writeTransactionBundle(dir, "rewards-42", [{ to, data: "0x" }]);
			expect(file).toBe(path.join(dir, "rewards-42.json"));
			expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(
				transactionBundle([{ to, data: "0x" }], 1337),
			);
		} finally {
			vi.useRealTimers();
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
});
