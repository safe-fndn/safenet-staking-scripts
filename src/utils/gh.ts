/**
 * Read-only access to the releases of a public GitHub repository.
 *
 * REST API requests are authenticated with `GITHUB_TOKEN` when it is set, to
 * lift the 60 requests an hour per IP limit for unauthenticated requests. As an
 * exception to the `src/utils/args.ts` convention, it is read directly from
 * the environment, on every request.
 */

import debug from "debug";
import { z } from "zod";
import { type Backoff, backoff } from "./backoff.js";

/** A GitHub repository as `owner/name`. */
export type GitHubRepository = `${string}/${string}`;

/**
 * Parses a GitHub repository as `owner/name`. The owner is 1-39 alphanumerics
 * or single inner hyphens, and the name is 1-100 alphanumerics, `.`, `_` or
 * `-`, but not `.` or `..`, as GitHub allows.
 */
export const zGitHubRepository = z
	.string()
	.regex(/^(?=[^/]{1,39}\/)[A-Za-z0-9](?:-?[A-Za-z0-9])*\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/)
	.transform((repo) => repo as GitHubRepository);

const RELEASES_PAGE_SIZE = 100;

const zReleases = z.array(z.object({ tag_name: z.string() }));

const defaultBackoff = (): Backoff => backoff({ debug: debug("safenet:gh") });

/**
 * Headers for a GitHub REST API request. Only these requests carry the token:
 * asset downloads are not subject to the API rate limit, and redirect to
 * another host that has no use for it.
 */
const apiHeaders = (): Record<string, string> => {
	const token = process.env.GITHUB_TOKEN;
	return token ? { Authorization: `Bearer ${token}` } : {};
};

// Errors only ever include the URL and status, never the request headers.
const fetchBytes = (
	url: string,
	withBackoff: Backoff,
	headers: Record<string, string> = {},
): Promise<Uint8Array> =>
	withBackoff(async () => {
		const response = await fetch(url, { headers });
		if (!response.ok) {
			throw new Error(`failed to fetch '${url}': ${response.status} ${response.statusText}`);
		}
		return new Uint8Array(await response.arrayBuffer());
	});

/**
 * Lists the tags of every release of a repository, in the order the GitHub
 * REST API returns them, paging until a page has fewer than 100 entries. Each
 * request is retried with `withBackoff`; malformed responses are not. Requests
 * are authenticated with `GITHUB_TOKEN` when it is set.
 */
export const releaseTags = async (
	repo: GitHubRepository,
	withBackoff: Backoff = defaultBackoff(),
): Promise<string[]> => {
	const tags = [];
	for (let page = 1; ; page++) {
		const url = `https://api.github.com/repos/${repo}/releases?per_page=${RELEASES_PAGE_SIZE}&page=${page}`;
		const raw = await fetchBytes(url, withBackoff, apiHeaders());
		const releases = zReleases.parse(JSON.parse(new TextDecoder().decode(raw)));
		tags.push(...releases.map(({ tag_name }) => tag_name));
		if (releases.length < RELEASES_PAGE_SIZE) {
			return tags;
		}
	}
};

/**
 * Downloads the raw bytes of a release asset, exactly as served, from
 * `https://github.com/<repo>/releases/download/<tag>/<asset>`. The request,
 * including a 404 for a missing asset, is retried with `withBackoff` and then
 * thrown. It is never authenticated.
 */
export const releaseAsset = (
	repo: GitHubRepository,
	{ tag, asset }: { tag: string; asset: string },
	withBackoff: Backoff = defaultBackoff(),
): Promise<Uint8Array> =>
	fetchBytes(
		`https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`,
		withBackoff,
	);
