import Sqlite3 from "better-sqlite3";
import { getAddress } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SanctionsData } from "./sanctions.js";

const jsonResponse = (body: unknown): Response =>
	new Response(JSON.stringify(body), { status: 200 });

const createSanctionsData = (sanctionsRepoUrl = "https://example.com/lists"): SanctionsData =>
	new SanctionsData({ db: new Sqlite3(":memory:"), sanctionsRepoUrl });

describe("SanctionsData", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns accounts sanctioned on-chain as of the given timestamp", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse([])),
		);

		const onchain = getAddress("0x0000000000000000000000000000000000000001");
		const data = createSanctionsData();
		data.registerSanction({ blockTimestamp: 10n, account: onchain, sanctioned: true });

		expect(await data.sanctionedAccounts({ toTimestamp: 20n })).toEqual([onchain]);
		expect(await data.sanctionedAccounts({ toTimestamp: 5n })).toEqual([]);
	});

	it("respects the latest sanction status as of the timestamp, not just whether it was ever sanctioned", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse([])),
		);

		const account = getAddress("0x0000000000000000000000000000000000000002");
		const data = createSanctionsData();
		data.registerSanction({ blockTimestamp: 10n, account, sanctioned: true });
		data.registerSanction({ blockTimestamp: 20n, account, sanctioned: false });

		expect(await data.sanctionedAccounts({ toTimestamp: 15n })).toEqual([account]);
		expect(await data.sanctionedAccounts({ toTimestamp: 25n })).toEqual([]);
	});

	it("merges and de-duplicates addresses across on-chain and all published offchain lists", async () => {
		const onchain = getAddress("0x0000000000000000000000000000000000000003");
		const un = getAddress("0x0000000000000000000000000000000000000004");
		// Same address sanctioned both on-chain and via an offchain list, in different casing.
		const shared = "0x0000000000000000000000000000000000000005";

		const fetch = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/un.json")) return jsonResponse([un, shared.toLowerCase()]);
			if (url.endsWith("/eu.json")) return jsonResponse([]);
			if (url.endsWith("/uk.json")) return jsonResponse([]);
			if (url.endsWith("/ch-seco.json")) return jsonResponse([]);
			if (url.endsWith("/us-ofac.json")) return jsonResponse([]);
			throw new Error(`unexpected url ${url}`);
		});
		vi.stubGlobal("fetch", fetch);

		const data = createSanctionsData();
		data.registerSanction({ blockTimestamp: 10n, account: onchain, sanctioned: true });
		data.registerSanction({
			blockTimestamp: 10n,
			account: getAddress(shared),
			sanctioned: true,
		});

		const accounts = await data.sanctionedAccounts({ toTimestamp: 20n });
		expect(new Set(accounts)).toEqual(new Set([onchain, un, getAddress(shared)]));
	});

	it("filters out offchain entries that are not valid addresses", async () => {
		const valid = getAddress("0x0000000000000000000000000000000000000006");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) =>
				String(input).endsWith("/un.json")
					? jsonResponse([valid, "not-an-address", ""])
					: jsonResponse([]),
			),
		);

		const data = createSanctionsData();
		expect(await data.sanctionedAccounts({ toTimestamp: 0n })).toEqual([valid]);
	});

	it("retries a failed offchain fetch before giving up", async () => {
		const valid = getAddress("0x0000000000000000000000000000000000000007");
		let attempts = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				if (!String(input).endsWith("/un.json")) {
					return jsonResponse([]);
				}
				attempts += 1;
				if (attempts < 2) {
					return new Response("", { status: 500, statusText: "Internal Server Error" });
				}
				return jsonResponse([valid]);
			}),
		);

		const data = createSanctionsData();
		expect(await data.sanctionedAccounts({ toTimestamp: 0n })).toEqual([valid]);
		expect(attempts).toBeGreaterThanOrEqual(2);
	});
});
