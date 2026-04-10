import type { Statement } from "better-sqlite3";
import { type Address, getAbiItem } from "viem";
import { SANCTIONS_LIST_ABI } from "../abi.js";
import type { FromBlock, ToTimestamp } from "../utils/ranges.js";
import { type BlockTimestamp, type Configuration, EventIndexer, type Log } from "./events.js";
import { SANCTIONS_LIST_SEED_DATA } from "./seeds/sanctions.js";

const EVENTS = [
	getAbiItem({ abi: SANCTIONS_LIST_ABI, name: "SanctionedAddressesAdded" }),
	getAbiItem({ abi: SANCTIONS_LIST_ABI, name: "SanctionedAddressesRemoved" }),
];

type Sanction = {
	blockTimestamp: bigint;
	account: Address;
	sanctioned: number;
};

type Instant = {
	blockTimestamp: bigint;
};

export class Sanctions extends EventIndexer<typeof EVENTS> {
	#queries: {
		upsertSanction: Statement<Sanction, number>;
		selectSanctionedAccounts: Statement<Instant, Address>;
	};

	constructor(config: Configuration) {
		super({
			name: "sanctions",
			events: EVENTS,
			...config,
		});

		this.db.exec(`
			CREATE TABLE IF NOT EXISTS sanctions(
				block_timestamp INTEGER NOT NULL,
				account TEXT NOT NULL,
				sanctioned INTEGER NOT NULL,
				PRIMARY KEY(block_timestamp, account)
			) WITHOUT ROWID;
		`);
		this.#queries = {
			upsertSanction: this.db.prepare<Sanction, number>(`
				INSERT INTO sanctions(block_timestamp, account, sanctioned)
				VALUES(@blockTimestamp, @account, @sanctioned)
				ON CONFLICT(block_timestamp, account)
				DO UPDATE SET sanctioned = EXCLUDED.sanctioned
			`),
			selectSanctionedAccounts: this.db.prepare<Instant, Address>(`
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
	}

	#insertEvent(log: Log<typeof EVENTS>): void {
		switch (log.eventName) {
			case "SanctionedAddressesAdded": {
				for (const account of log.args.addrs) {
					this.#queries.upsertSanction.run({
						blockTimestamp: log.blockTimestamp,
						account,
						sanctioned: 1,
					});
				}
				break;
			}
			case "SanctionedAddressesRemoved": {
				for (const account of log.args.addrs) {
					this.#queries.upsertSanction.run({
						blockTimestamp: log.blockTimestamp,
						account,
						sanctioned: 0,
					});
				}
				break;
			}
		}
	}

	protected seed(contract: string, { fromBlock }: FromBlock): BlockTimestamp | null {
		const seedData = SANCTIONS_LIST_SEED_DATA[contract];
		if (seedData === undefined || fromBlock > seedData.lastUpdatedBlock.number) {
			return null;
		}

		for (const log of seedData.events) {
			if (log.blockTimestamp >= fromBlock) {
				this.#insertEvent(log);
			}
		}
		return seedData.lastUpdatedBlock;
	}

	protected insertEvent(log: Log<typeof EVENTS>): void {
		this.#insertEvent(log);
	}

	sanctionedAccounts({ toTimestamp }: ToTimestamp): Address[] {
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
}
