/**
 * Read-only access to the releases of a public GitHub repository, without
 * authentication.
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

const fetchBytes = (url: string, withBackoff: Backoff): Promise<Uint8Array> =>
	withBackoff(async () => {
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`failed to fetch '${url}': ${response.status} ${response.statusText}`);
		}
		return new Uint8Array(await response.arrayBuffer());
	});

/**
 * Lists the tags of every release of a repository, in the order the GitHub
 * REST API returns them, paging until a page has fewer than 100 entries. Each
 * request is retried with `withBackoff`; malformed responses are not.
 */
export const releaseTags = async (
	repo: GitHubRepository,
	withBackoff: Backoff = defaultBackoff(),
): Promise<string[]> => {
	const tags = [];
	for (let page = 1; ; page++) {
		const url = `https://api.github.com/repos/${repo}/releases?per_page=${RELEASES_PAGE_SIZE}&page=${page}`;
		const raw = await fetchBytes(url, withBackoff);
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
 * thrown.
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
