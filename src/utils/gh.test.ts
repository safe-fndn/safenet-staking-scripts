import { afterEach, describe, expect, it, vi } from "vitest";
import { backoff } from "./backoff.js";
import { type GitHubRepository, releaseAsset, releaseTags, zGitHubRepository } from "./gh.js";

const REPO = "example/lists" as GitHubRepository;

// Retries each failed request twice, without waiting.
const fastBackoff = backoff({ delays: [0, 0] });

const releasesUrl = (page: number) =>
	`https://api.github.com/repos/example/lists/releases?per_page=100&page=${page}`;

/** Stubs `fetch` with a handler, recording every requested URL. */
const stubFetch = (handler: (url: string) => Response) => {
	const fetch = vi.fn(async (input: string | URL | Request) => handler(String(input)));
	vi.stubGlobal("fetch", fetch);
	return () => fetch.mock.calls.map(([url]) => String(url));
};

/** Stubs the release listing with the given pages of tags. */
const stubReleases = (pages: string[][]) =>
	stubFetch((url) => {
		const page = pages.findIndex((_, i) => url === releasesUrl(i + 1));
		if (page === -1) {
			throw new Error(`unexpected url ${url}`);
		}
		return Response.json(pages[page].map((tag_name) => ({ tag_name, name: tag_name })));
	});

const tags = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("zGitHubRepository", () => {
	it("accepts owner/name repositories", () => {
		for (const repo of [
			"safe-fndn/sanctions-address-lists",
			"a/b",
			"Owner-1/repo.name_2",
			"owner/.github",
			`${"a".repeat(39)}/${"b".repeat(100)}`,
		]) {
			expect(zGitHubRepository.safeParse(repo).data, repo).toBe(repo);
		}
	});

	it("rejects anything else", () => {
		for (const repo of [
			"",
			"owner",
			"owner/",
			"/repo",
			"owner/repo/extra",
			"-owner/repo",
			"owner-/repo",
			"own--er/repo",
			"own_er/repo",
			"owner/.",
			"owner/..",
			"owner/re po",
			"owner/repo?x=1",
			"https://github.com/owner/repo",
			`${"a".repeat(40)}/repo`,
			`owner/${"b".repeat(101)}`,
		]) {
			expect(zGitHubRepository.safeParse(repo).success, repo).toBe(false);
		}
	});
});

describe("releaseTags", () => {
	it("lists the tags of a single page", async () => {
		const urls = stubReleases([["latest", "data-2026-10-26"]]);
		expect(await releaseTags(REPO, fastBackoff)).toEqual(["latest", "data-2026-10-26"]);
		expect(urls()).toEqual([releasesUrl(1)]);
	});

	it("pages until a page has fewer than 100 entries", async () => {
		const first = tags("a", 100);
		const second = tags("b", 100);
		const urls = stubReleases([first, second, ["c"]]);
		expect(await releaseTags(REPO, fastBackoff)).toEqual([...first, ...second, "c"]);
		expect(urls()).toEqual([releasesUrl(1), releasesUrl(2), releasesUrl(3)]);
	});

	it("fetches an empty page after a page of exactly 100 entries", async () => {
		const first = tags("a", 100);
		const urls = stubReleases([first, []]);
		expect(await releaseTags(REPO, fastBackoff)).toEqual(first);
		expect(urls()).toEqual([releasesUrl(1), releasesUrl(2)]);
	});

	it("returns no tags for a repository without releases", async () => {
		const urls = stubReleases([[]]);
		expect(await releaseTags(REPO, fastBackoff)).toEqual([]);
		expect(urls()).toEqual([releasesUrl(1)]);
	});

	it("retries a failed request", async () => {
		let attempts = 0;
		stubFetch(() => {
			attempts++;
			return attempts < 3
				? new Response("", { status: 503, statusText: "Service Unavailable" })
				: Response.json([{ tag_name: "latest" }]);
		});
		expect(await releaseTags(REPO, fastBackoff)).toEqual(["latest"]);
		expect(attempts).toBe(3);
	});

	it("throws once the retries are exhausted", async () => {
		const urls = stubFetch(() => new Response("", { status: 403, statusText: "Forbidden" }));
		await expect(releaseTags(REPO, fastBackoff)).rejects.toThrow(
			`failed to fetch '${releasesUrl(1)}': 403 Forbidden`,
		);
		expect(urls()).toHaveLength(3);
	});

	it("does not retry a malformed listing", async () => {
		const urls = stubFetch(() => Response.json({ message: "Not Found" }));
		await expect(releaseTags(REPO, fastBackoff)).rejects.toThrow();
		expect(urls()).toHaveLength(1);
	});
});

describe("releaseAsset", () => {
	const assetUrl = "https://github.com/example/lists/releases/download/data-2026-10-26/un.json";

	it("returns the raw asset bytes unmodified", async () => {
		// Not valid UTF-8, with a BOM-like prefix and no trailing newline, so any
		// decoding or normalization would show.
		const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x5b, 0x5d, 0x0d, 0x0a, 0xff, 0x00]);
		const urls = stubFetch((url) => {
			if (url !== assetUrl) {
				throw new Error(`unexpected url ${url}`);
			}
			return new Response(bytes, { status: 200 });
		});
		expect(
			await releaseAsset(REPO, { tag: "data-2026-10-26", asset: "un.json" }, fastBackoff),
		).toEqual(bytes);
		expect(urls()).toEqual([assetUrl]);
	});

	it("retries a failed download", async () => {
		let attempts = 0;
		stubFetch(() => {
			attempts++;
			return attempts < 2
				? new Response("", { status: 500, statusText: "Internal Server Error" })
				: new Response("[]");
		});
		const bytes = await releaseAsset(
			REPO,
			{ tag: "data-2026-10-26", asset: "un.json" },
			fastBackoff,
		);
		expect(new TextDecoder().decode(bytes)).toBe("[]");
		expect(attempts).toBe(2);
	});

	it("throws for a missing asset once the retries are exhausted", async () => {
		const urls = stubFetch(() => new Response("", { status: 404, statusText: "Not Found" }));
		await expect(
			releaseAsset(REPO, { tag: "data-2026-10-26", asset: "un.json" }, fastBackoff),
		).rejects.toThrow(`failed to fetch '${assetUrl}': 404 Not Found`);
		expect(urls()).toEqual([assetUrl, assetUrl, assetUrl]);
	});
});

describe("GITHUB_TOKEN", () => {
	const TOKEN = "ghs_0123456789abcdefghijklmnopqrstuvwxyz";

	/** Stubs `fetch`, recording the `Authorization` header of every request by URL. */
	const stubAuthorization = (status = 200) => {
		const requests: [string, string | null][] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				requests.push([url, new Headers(init?.headers).get("authorization")]);
				if (status !== 200) {
					return new Response("", { status, statusText: "Unauthorized" });
				}
				return url.startsWith("https://api.github.com/")
					? Response.json([{ tag_name: "latest" }])
					: new Response("[]");
			}),
		);
		return requests;
	};

	const asset = { tag: "data-2026-10-26", asset: "un.json" };

	it("authenticates release listing requests when set", async () => {
		vi.stubEnv("GITHUB_TOKEN", TOKEN);
		const requests = stubAuthorization();
		await releaseTags(REPO, fastBackoff);
		expect(requests).toEqual([[releasesUrl(1), `Bearer ${TOKEN}`]]);
	});

	it("reads the token on every request", async () => {
		const requests = stubAuthorization();
		vi.stubEnv("GITHUB_TOKEN", "first");
		await releaseTags(REPO, fastBackoff);
		vi.stubEnv("GITHUB_TOKEN", "second");
		await releaseTags(REPO, fastBackoff);
		expect(requests.map(([, authorization]) => authorization)).toEqual([
			"Bearer first",
			"Bearer second",
		]);
	});

	it("sends no token when unset or empty", async () => {
		const requests = stubAuthorization();
		vi.stubEnv("GITHUB_TOKEN", undefined);
		await releaseTags(REPO, fastBackoff);
		vi.stubEnv("GITHUB_TOKEN", "");
		await releaseTags(REPO, fastBackoff);
		expect(requests).toEqual([
			[releasesUrl(1), null],
			[releasesUrl(1), null],
		]);
	});

	it("never sends the token with asset downloads", async () => {
		vi.stubEnv("GITHUB_TOKEN", TOKEN);
		const requests = stubAuthorization();
		await releaseAsset(REPO, asset, fastBackoff);
		expect(requests).toEqual([
			["https://github.com/example/lists/releases/download/data-2026-10-26/un.json", null],
		]);
	});

	it("keeps the token out of error messages", async () => {
		vi.stubEnv("GITHUB_TOKEN", TOKEN);
		stubAuthorization(401);
		const error = await releaseTags(REPO, fastBackoff).catch((err: Error) => err);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe(`failed to fetch '${releasesUrl(1)}': 401 Unauthorized`);
		expect((error as Error).message).not.toContain(TOKEN);
	});
});
