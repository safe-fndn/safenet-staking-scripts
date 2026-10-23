import Sqlite3 from "better-sqlite3";
import { getAddress } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitHubRepository } from "../utils/gh.js";
import { SanctionsData, selectSnapshotRelease } from "./sanctions.js";

const jsonResponse = (body: unknown): Response =>
	new Response(JSON.stringify(body), { status: 200 });

const createSanctionsData = (sanctionsAddressRepo?: GitHubRepository): SanctionsData =>
	new SanctionsData({ db: new Sqlite3(":memory:"), sanctionsAddressRepo });

/** The URLs of every `<source>.json` asset in a repository's `latest` release, sorted. */
const latestAssetUrls = (repo: string): string[] =>
	["ch-seco", "eu", "uk", "un", "us-ofac"].map(
		(source) => `https://github.com/${repo}/releases/download/latest/${source}.json`,
	);

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

	it("fetches the lists from the latest release of the default repository", async () => {
		const fetch = vi.fn(async (_input: string | URL | Request) => jsonResponse([]));
		vi.stubGlobal("fetch", fetch);

		await createSanctionsData().sanctionedAccounts({ toTimestamp: 0n });
		expect(fetch.mock.calls.map(([url]) => String(url)).sort()).toEqual(
			latestAssetUrls("safe-fndn/sanctions-address-lists"),
		);
	});

	it("fetches the lists from the latest release of a configured repository", async () => {
		const valid = getAddress("0x0000000000000000000000000000000000000008");
		const urls = latestAssetUrls("example/lists");
		const fetch = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (!urls.includes(url)) {
				throw new Error(`unexpected url ${url}`);
			}
			return jsonResponse(url.endsWith("/eu.json") ? [valid] : []);
		});
		vi.stubGlobal("fetch", fetch);

		const data = createSanctionsData("example/lists");
		expect(await data.sanctionedAccounts({ toTimestamp: 0n })).toEqual([valid]);
		expect(fetch.mock.calls.map(([url]) => String(url)).sort()).toEqual(urls);
	});
});

const timestamp = (date: string): bigint => BigInt(Date.parse(date) / 1000);

/**
 * Fakes a repository's GitHub release listing (a single page) and release
 * asset downloads, serving the given raw `<source>.json` bodies per release.
 * Any other URL is rejected.
 */
const stubReleases = (
	releases: string[],
	assets: Record<string, Record<string, string>>,
	repo = "safe-fndn/sanctions-address-lists",
) => {
	const fetch = vi.fn(async (input: string | URL | Request) => {
		const url = String(input);
		if (url === `https://api.github.com/repos/${repo}/releases?per_page=100&page=1`) {
			return jsonResponse(releases.map((tag_name) => ({ tag_name, name: tag_name })));
		}
		for (const [release, files] of Object.entries(assets)) {
			for (const [source, body] of Object.entries(files)) {
				if (url === `https://github.com/${repo}/releases/download/${release}/${source}.json`) {
					return new Response(body, { status: 200 });
				}
			}
		}
		throw new Error(`unexpected url ${url}`);
	});
	vi.stubGlobal("fetch", fetch);
	return () => fetch.mock.calls.map(([url]) => String(url)).sort();
};

const EMPTY_LISTS = {
	un: "[]\n",
	eu: "[]\n",
	uk: "[]\n",
	"ch-seco": "[]\n",
	"us-ofac": "[]\n",
};

describe("selectSnapshotRelease", () => {
	const releases = ["latest", "data-2026-10-27", "data-2026-10-26", "data-2026-10-20"];

	it("selects the newest snapshot whose day ended at or before the period end", () => {
		// The first Aegis period ends at Tuesday 2026-10-27 00:00 UTC, which is
		// exactly when the 2026-10-26 snapshot can no longer change.
		expect(
			selectSnapshotRelease(releases, { toTimestamp: timestamp("2026-10-27T00:00:00Z") }),
		).toBe("data-2026-10-26");
		expect(
			selectSnapshotRelease(releases, { toTimestamp: timestamp("2026-10-26T23:59:59Z") }),
		).toBe("data-2026-10-20");
		expect(
			selectSnapshotRelease(releases, { toTimestamp: timestamp("2026-10-27T00:00:01Z") }),
		).toBe("data-2026-10-26");
		expect(
			selectSnapshotRelease(releases, { toTimestamp: timestamp("2026-10-28T00:00:00Z") }),
		).toBe("data-2026-10-27");
	});

	it("does not depend on the release order", () => {
		expect(
			selectSnapshotRelease([...releases].reverse(), {
				toTimestamp: timestamp("2026-11-10T00:00:00Z"),
			}),
		).toBe("data-2026-10-27");
	});

	it("never selects latest", () => {
		expect(
			selectSnapshotRelease(["latest"], { toTimestamp: timestamp("2100-01-01T00:00:00Z") }),
		).toBeNull();
	});

	it("ignores releases that are not valid snapshot dates", () => {
		expect(
			selectSnapshotRelease(
				[
					"data-2026-02-30",
					"data-2026-13-01",
					"data-2026-00-10",
					"data-2026-1-01",
					"data-2026-01-01x",
					"xdata-2026-01-01",
				],
				{ toTimestamp: timestamp("2027-01-01T00:00:00Z") },
			),
		).toBeNull();
		// A leap day is a real date.
		expect(
			selectSnapshotRelease(["data-2028-02-29"], {
				toTimestamp: timestamp("2028-03-01T00:00:00Z"),
			}),
		).toBe("data-2028-02-29");
	});

	it("returns null when no snapshot ended by the period end", () => {
		expect(
			selectSnapshotRelease(releases, { toTimestamp: timestamp("2026-10-20T23:59:59Z") }),
		).toBeNull();
	});
});

describe("SanctionsData.pinnedSanctionedAccounts", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const period = { toTimestamp: timestamp("2026-10-27T00:00:00Z") };

	it("fetches the lists from the period's snapshot", async () => {
		const onchain = getAddress("0x0000000000000000000000000000000000000011");
		const pinned = getAddress("0x0000000000000000000000000000000000000012");
		const later = getAddress("0x0000000000000000000000000000000000000013");
		const ofac = `[\n  "${pinned.toLowerCase()}"\n]\n`;
		const urls = stubReleases(["latest", "data-2026-10-27", "data-2026-10-26"], {
			latest: { ...EMPTY_LISTS, "us-ofac": JSON.stringify([later]) },
			"data-2026-10-26": { ...EMPTY_LISTS, "us-ofac": ofac },
			"data-2026-10-27": { ...EMPTY_LISTS, "us-ofac": JSON.stringify([later]) },
		});

		const data = createSanctionsData();
		data.registerSanction({ blockTimestamp: 10n, account: onchain, sanctioned: true });

		expect(await data.pinnedSanctionedAccounts(period)).toEqual({
			accounts: [onchain, pinned],
			release: "data-2026-10-26",
		});
		// Only the release listing and the pinned snapshot's assets are fetched.
		expect(urls()).toEqual([
			"https://api.github.com/repos/safe-fndn/sanctions-address-lists/releases?per_page=100&page=1",
			...latestAssetUrls("safe-fndn/sanctions-address-lists").map((url) =>
				url.replace("/latest/", "/data-2026-10-26/"),
			),
		]);
	});

	it("uses a configured repository for the listing and the snapshot assets", async () => {
		const pinned = getAddress("0x0000000000000000000000000000000000000014");
		const urls = stubReleases(
			["data-2026-10-26"],
			{ "data-2026-10-26": { ...EMPTY_LISTS, un: JSON.stringify([pinned]) } },
			"example/lists",
		);

		const result = await createSanctionsData("example/lists").pinnedSanctionedAccounts(period);
		expect(result.accounts).toEqual([pinned]);
		expect(result.release).toBe("data-2026-10-26");
		expect(urls()).toEqual([
			"https://api.github.com/repos/example/lists/releases?per_page=100&page=1",
			...latestAssetUrls("example/lists").map((url) =>
				url.replace("/latest/", "/data-2026-10-26/"),
			),
		]);
	});

	it("fails when no snapshot ended by the period end", async () => {
		stubReleases(["latest", "data-2026-10-27"], {
			latest: EMPTY_LISTS,
			"data-2026-10-27": EMPTY_LISTS,
		});

		await expect(createSanctionsData().pinnedSanctionedAccounts(period)).rejects.toThrow(
			`no sanctions address lists snapshot ended by ${period.toTimestamp}`,
		);
	});
});
