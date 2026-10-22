/**
 * Sanctions data source.
 *
 * Combines two independent sources of sanctioned addresses:
 * - The on-chain Chainalysis sanctions oracle, indexed like any other chain
 *   event (see `src/indexing/sanctions.ts`) and stored with a block
 *   timestamp, so historic payouts can be recomputed reproducibly.
 * - The UN, EU, UK, Swiss SECO and US OFAC address lists published as
 *   release assets of a `sanctions-address-lists` GitHub repository
 *   (<https://github.com/safe-fndn/sanctions-address-lists> unless
 *   configured otherwise). These have no on-chain timestamp, so they are
 *   either fetched live from the moving `latest` release, or pinned to the
 *   dated `data-YYYY-MM-DD` snapshot release for a period.
 */

import { createHash } from "node:crypto";
import type { Database, Statement } from "better-sqlite3";
import debug from "debug";
import { type Address, getAddress, isAddress } from "viem";
import { z } from "zod";
import { type Backoff, backoff } from "../utils/backoff.js";
import { type GitHubRepository, releaseAsset, releaseTags } from "../utils/gh.js";
import type { ToTimestamp } from "../utils/ranges.js";

type Sanction<bool = boolean> = {
	blockTimestamp: bigint;
	account: Address;
	sanctioned: bool;
};

type SanctionInstant = {
	blockTimestamp: bigint;
};

/** Per-jurisdiction source identifiers, matching the release asset file names. */
const OFFCHAIN_SOURCES = ["un", "eu", "uk", "ch-seco", "us-ofac"] as const;

export type OffchainSource = (typeof OFFCHAIN_SOURCES)[number];

/** The GitHub repository that publishes the offchain address lists, unless configured otherwise. */
export const DEFAULT_SANCTIONS_ADDRESS_REPO: GitHubRepository = "safe-fndn/sanctions-address-lists";

const SNAPSHOT_RELEASE_PATTERN = /^data-(\d{4})-(\d{2})-(\d{2})$/;
const DAY = 60n * 60n * 24n;

const zAddressList = z.array(z.string());

/**
 * The offchain address lists a set of sanctioned accounts was computed from:
 * the `data-YYYY-MM-DD` snapshot release, and the SHA-256 (lowercase hex) of
 * each source's raw `<source>.json` release asset.
 */
export type OffchainSanctions = {
	release: string;
	sha256: Record<OffchainSource, string>;
};

export type PinnedSanctionedAccounts = {
	accounts: Address[];
	offchain: OffchainSanctions;
};

type OffchainList = {
	sha256: string;
	accounts: Address[];
};

/**
 * Selects the snapshot release for a period: the newest `data-YYYY-MM-DD`
 * release whose UTC day ended at or before `toTimestamp`. The upstream publish
 * job may re-upload a snapshot's assets until its day is over, so a snapshot
 * only counts once it can no longer change. Returns `null` if there is none.
 */
export const selectSnapshotRelease = (
	releases: string[],
	{ toTimestamp }: ToTimestamp,
): string | null => {
	let selected: { release: string; day: bigint } | null = null;
	for (const release of releases) {
		const match = SNAPSHOT_RELEASE_PATTERN.exec(release);
		if (match === null) {
			continue;
		}
		const [year, month, day] = match.slice(1).map(Number);
		const date = new Date(Date.UTC(year, month - 1, day));
		// `Date.UTC` rolls out-of-range parts over (`data-2026-02-30` is 2026-03-02). Checking the
		// year and month also catches a bad day.
		if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1) {
			continue;
		}
		const start = BigInt(date.getTime() / 1000);
		if (start + DAY <= toTimestamp && (selected === null || start > selected.day)) {
			selected = { release, day: start };
		}
	}
	return selected?.release ?? null;
};

export type SanctionsDataConfiguration = {
	db: Database;
	/**
	 * The GitHub repository whose release assets the per-source `<source>.json`
	 * offchain address lists are fetched from. Defaults to
	 * `DEFAULT_SANCTIONS_ADDRESS_REPO`.
	 */
	sanctionsAddressRepo?: GitHubRepository;
};

export class SanctionsData {
	#db: Database;
	#queries: {
		upsertSanction: Statement<Sanction<0 | 1>, number>;
		selectSanctionedAccounts: Statement<SanctionInstant, Address>;
	};
	#sanctionsAddressRepo: GitHubRepository;
	#backoff: Backoff;

	constructor({ db, sanctionsAddressRepo }: SanctionsDataConfiguration) {
		this.#db = db;
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS sanctions(
				block_timestamp INTEGER NOT NULL,
				account TEXT NOT NULL,
				sanctioned INTEGER NOT NULL,
				PRIMARY KEY(block_timestamp, account)
			) WITHOUT ROWID;
		`);
		this.#queries = {
			upsertSanction: this.#db.prepare<Sanction<0 | 1>, number>(`
				INSERT INTO sanctions(block_timestamp, account, sanctioned)
				VALUES(@blockTimestamp, @account, @sanctioned)
				ON CONFLICT(block_timestamp, account)
				DO UPDATE SET sanctioned = EXCLUDED.sanctioned
			`),
			selectSanctionedAccounts: this.#db.prepare<SanctionInstant, Address>(`
				WITH sanctioned_at_block AS (
					SELECT account
					, sanctioned
					, row_number() OVER (
						PARTITION BY account
						ORDER BY block_timestamp DESC
					) AS n
					FROM sanctions
					WHERE block_timestamp <= @blockTimestamp
				)
				SELECT account
				FROM sanctioned_at_block
				WHERE sanctioned = TRUE
				AND n = 1
				ORDER BY account COLLATE NOCASE ASC
			`),
		};
		this.#sanctionsAddressRepo = sanctionsAddressRepo ?? DEFAULT_SANCTIONS_ADDRESS_REPO;
		this.#backoff = backoff({ debug: debug("safenet:sanctions-lists") });
	}

	get db() {
		return this.#db;
	}

	registerSanction({ blockTimestamp, account, sanctioned }: Sanction): void {
		this.#queries.upsertSanction.run({
			blockTimestamp,
			account,
			sanctioned: Number(sanctioned) as 0 | 1,
		});
	}

	#onchainSanctionedAccounts({ toTimestamp }: ToTimestamp): Address[] {
		// For sanctions, we see which addresses are sanctioned **at the time
		// of payout**, i.e. at the end of the period. This means if an address
		// is added and then later removed within a rewards period, we still
		// consider them. Conversely, if an address is added partway through the
		// rewards period, they are considered sanctioned for the total period
		// and are not considered for the rewards computation. Since rewards
		// will be computed regularly, we consider sanctions at the moment of
		// payout (and not the latest sanctions list):
		// - Since the rewards are done regularly, we will from a practical
		//   perspective be using the latest sanctions list every time we
		//   distribute rewards.
		// - Using sanctions at the moment of payout allows us to recompute
		//   historic payouts, so if an account was eligible for payouts and
		//   then later added to the sanctions list (thereby excluding it
		//   from future payout eligibility), the scripts will still produce
		//   the same result on the historic data.
		const blockTimestamp = toTimestamp;
		return this.#queries.selectSanctionedAccounts.pluck().all({ blockTimestamp });
	}

	async #fetchOffchainSource(tag: string, source: OffchainSource): Promise<OffchainList> {
		// The hash is over the raw asset bytes, as served, so that it can be
		// checked against the release with nothing more than `sha256sum`.
		const raw = await releaseAsset(
			this.#sanctionsAddressRepo,
			{ tag, asset: `${source}.json` },
			this.#backoff,
		);
		const sha256 = createHash("sha256").update(raw).digest("hex");
		const body = JSON.parse(new TextDecoder().decode(raw));

		// The published lists are address-only screening: addresses are only
		// included when explicitly published by the official source, never
		// inferred from names or enriched from third parties. We additionally
		// filter out anything that does not parse as an address here, in case a
		// future format revision mixes in metadata we do not expect.
		const accounts = zAddressList
			.parse(body)
			.filter((address) => isAddress(address))
			.map((address) => getAddress(address));
		return { sha256, accounts };
	}

	async #offchainLists(tag: string): Promise<Record<OffchainSource, OffchainList>> {
		const lists = await Promise.all(
			OFFCHAIN_SOURCES.map(async (source) => {
				const list = await this.#fetchOffchainSource(tag, source);
				return [source, list] as const;
			}),
		);
		return Object.fromEntries(lists) as Record<OffchainSource, OffchainList>;
	}

	/**
	 * Resolves the `data-YYYY-MM-DD` snapshot release of the offchain address
	 * lists for a period. See `selectSnapshotRelease` for the rule.
	 */
	async snapshotRelease(period: ToTimestamp): Promise<string> {
		const tags = await releaseTags(this.#sanctionsAddressRepo, this.#backoff);
		const release = selectSnapshotRelease(tags, period);
		if (release === null) {
			throw new Error(`no sanctions address lists snapshot ended by ${period.toTimestamp}`);
		}
		return release;
	}

	/**
	 * Returns the accounts sanctioned as of a given timestamp: those flagged
	 * by the on-chain Chainalysis oracle, unioned with the UN, EU, UK, Swiss
	 * SECO and US OFAC addresses currently published in the `latest` release
	 * of the configured `sanctions-address-lists` repository.
	 */
	async sanctionedAccounts({ toTimestamp }: ToTimestamp): Promise<Address[]> {
		const onchain = this.#onchainSanctionedAccounts({ toTimestamp });
		const lists = await this.#offchainLists("latest");
		const offchain = Object.values(lists).flatMap(({ accounts }) => accounts);
		return [...new Set([...onchain, ...offchain])];
	}

	/**
	 * Returns the accounts sanctioned for a period, like `sanctionedAccounts`,
	 * but with the offchain lists pinned to the period's snapshot release (see
	 * `snapshotRelease`), along with the release and per-source hashes used.
	 *
	 * When `expected` is given, the resolved release and every hash must match
	 * it, so a recorded result can be checked against the published snapshot.
	 */
	async pinnedSanctionedAccounts(
		period: ToTimestamp,
		expected?: OffchainSanctions,
	): Promise<PinnedSanctionedAccounts> {
		const release = await this.snapshotRelease(period);
		if (expected !== undefined && release !== expected.release) {
			throw new Error(
				`sanctions address lists snapshot ${release} does not match expected ${expected.release}`,
			);
		}

		const lists = await this.#offchainLists(release);
		const sha256 = {} as Record<OffchainSource, string>;
		for (const source of OFFCHAIN_SOURCES) {
			sha256[source] = lists[source].sha256;
			if (expected !== undefined && sha256[source] !== expected.sha256[source]) {
				throw new Error(
					`sanctions address list ${source} in ${release} has SHA-256 ${sha256[source]}, expected ${expected.sha256[source]}`,
				);
			}
		}

		const onchain = this.#onchainSanctionedAccounts(period);
		const offchain = Object.values(lists).flatMap(({ accounts }) => accounts);
		return {
			accounts: [...new Set([...onchain, ...offchain])],
			offchain: { release, sha256 },
		};
	}
}
