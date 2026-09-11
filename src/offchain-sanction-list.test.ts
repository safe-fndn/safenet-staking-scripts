import { getAddress } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SanctionsAddressLists } from "./sanctions-lists.js";

const jsonResponse = (body: unknown): Response =>
	new Response(JSON.stringify(body), { status: 200 });

describe("SanctionsAddressLists", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("merges and de-duplicates addresses across all published lists", async () => {
		const un = "0x0000000000000000000000000000000000000001";
		const eu = "0x0000000000000000000000000000000000000002";
		// Same address published by both the UK and US OFAC lists, in different casing.
		const shared = "0x0000000000000000000000000000000000000003";

		const fetch = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/un.json")) return jsonResponse([un]);
			if (url.endsWith("/eu.json")) return jsonResponse([eu]);
			if (url.endsWith("/uk.json")) return jsonResponse([shared.toLowerCase()]);
			if (url.endsWith("/ch-seco.json")) return jsonResponse([]);
			if (url.endsWith("/us-ofac.json"))
				return jsonResponse([shared.toUpperCase().replace("0X", "0x")]);
			throw new Error(`unexpected url ${url}`);
		});
		vi.stubGlobal("fetch", fetch);

		const lists = new SanctionsAddressLists({ baseUrl: "https://example.com/lists" });
		const accounts = await lists.accounts();

		expect(new Set(accounts)).toEqual(
			new Set([getAddress(un), getAddress(eu), getAddress(shared)]),
		);
		expect(fetch).toHaveBeenCalledWith("https://example.com/lists/un.json");
	});

	it("filters out entries that are not valid addresses", async () => {
		const valid = "0x0000000000000000000000000000000000000004";
		const fetch = vi.fn(async () => jsonResponse([valid, "not-an-address", ""]));
		vi.stubGlobal("fetch", fetch);

		const lists = new SanctionsAddressLists({ baseUrl: "https://example.com/lists" });
		const accounts = await lists.accounts();

		expect(accounts).toEqual([getAddress(valid)]);
	});

	it("retries a failed fetch before giving up", async () => {
		const valid = "0x0000000000000000000000000000000000000005";
		let attempts = 0;
		const fetch = vi.fn(async () => {
			attempts += 1;
			if (attempts < 2) {
				return new Response("", { status: 500, statusText: "Internal Server Error" });
			}
			return jsonResponse([valid]);
		});
		vi.stubGlobal("fetch", fetch);

		const lists = new SanctionsAddressLists({ baseUrl: "https://example.com/lists" });
		const accounts = await lists.accounts();

		expect(accounts).toContain(getAddress(valid));
		expect(attempts).toBeGreaterThanOrEqual(2);
	});
});
