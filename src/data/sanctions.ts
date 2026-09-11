/**
 * Sanctions data source.
 *
 * Combines two independent sources of sanctioned addresses:
 * - The on-chain Chainalysis sanctions oracle, indexed like any other chain
 *   event (see `src/indexing/sanctions.ts`) and stored with a block
 *   timestamp, so historic payouts can be recomputed reproducibly.
 * - The UN, EU, UK, Swiss SECO and US OFAC address lists published by the
 *   `sanctions-address-lists` project
 *   <https://github.com/safe-research/sanctions-address-lists>, fetched live
 *   since there is no on-chain timestamp to pin them to.
 */

import type { Database, Statement } from "better-sqlite3";
import debug from "debug";
import { type Address, getAddress, isAddress } from "viem";
import { z } from "zod";
import { type Backoff, backoff } from "../utils/backoff.js";
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

export const DEFAULT_SANCTIONS_REPO_URL =
	"https://github.com/safe-research/sanctions-address-lists/releases/download/latest";

const zAddressList = z.array(z.string());

export type SanctionsDataConfiguration = {
	db: Database;
	/** Base URL that per-source `<source>.json` offchain address lists are fetched from. */
	sanctionsRepoUrl?: string;
};

export class SanctionsData {
	#db: Database;
	#queries: {
		upsertSanction: Statement<Sanction<0 | 1>, number>;
		selectSanctionedAccounts: Statement<SanctionInstant, Address>;
	};
	#sanctionsRepoUrl: string;
	#backoff: Backoff;

	constructor({ db, sanctionsRepoUrl }: SanctionsDataConfiguration) {
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
		this.#sanctionsRepoUrl = sanctionsRepoUrl ?? DEFAULT_SANCTIONS_REPO_URL;
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

	async #fetchOffchainSource(source: string): Promise<Address[]> {
		const url = `${this.#sanctionsRepoUrl}/${source}.json`;
		const body = await this.#backoff(async () => {
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`failed to fetch '${url}': ${response.status} ${response.statusText}`);
			}
			return await response.json();
		});

		// The published lists are address-only screening: addresses are only
		// included when explicitly published by the official source, never
		// inferred from names or enriched from third parties. We additionally
		// filter out anything that does not parse as an address here, in case a
		// future format revision mixes in metadata we do not expect.
		return zAddressList
			.parse(body)
			.filter((address) => isAddress(address))
			.map((address) => getAddress(address));
	}

	async #offchainSanctionedAccounts(): Promise<Address[]> {
		const lists = await Promise.all(
			OFFCHAIN_SOURCES.map((source) => this.#fetchOffchainSource(source)),
		);
		return [...new Set(lists.flat())];
	}

	/**
	 * Returns the accounts sanctioned as of a given timestamp: those flagged
	 * by the on-chain Chainalysis oracle, unioned with the UN, EU, UK, Swiss
	 * SECO and US OFAC addresses currently published by `sanctions-address-lists`.
	 */
	async sanctionedAccounts({ toTimestamp }: ToTimestamp): Promise<Address[]> {
		const onchain = this.#onchainSanctionedAccounts({ toTimestamp });
		const offchain = await this.#offchainSanctionedAccounts();
		return [...new Set([...onchain, ...offchain])];
	}
}
