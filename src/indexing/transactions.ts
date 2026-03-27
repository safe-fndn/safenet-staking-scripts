import type { Statement } from "better-sqlite3";
import { getAbiItem } from "viem";
import { CONSENSUS_ABI } from "../abi.js";
import { type Configuration, EventIndexer, type ParsedLog } from "./events.js";

const EVENTS = [getAbiItem({ abi: CONSENSUS_ABI, name: "TransactionProposed" })];

export class Transactions extends EventIndexer<typeof EVENTS> {
	#queries: {
		upsertIncrementTransactionCount: Statement<[], number>;
		selectTransactionCount: Statement<[], number>;
	};

	constructor(config: Configuration) {
		super({
			name: "transactions",
			events: EVENTS,
			...config,
		});

		this.db.exec(`
			CREATE TABLE IF NOT EXISTS transactions(
				id TEXT NOT NULL,
				cnt INTEGER NOT NULL,
				PRIMARY KEY(id),
				CHECK(id = 0)
			);
		`);
		this.#queries = {
			upsertIncrementTransactionCount: this.db.prepare<[], number>(`
				INSERT INTO transactions(id, cnt)
				VALUES(0, 1)
				ON CONFLICT(id)
				DO UPDATE SET cnt = cnt + 1
			`),
			selectTransactionCount: this.db.prepare<[], number>(`
				SELECT cnt
				FROM transactions
				WHERE id = 0
			`),
		};
	}

	protected insertEvent(log: ParsedLog<typeof EVENTS>): void {
		switch (log.eventName) {
			case "TransactionProposed": {
				this.#queries.upsertIncrementTransactionCount.run();
				break;
			}
		}
	}

	count(): number {
		return this.#queries.selectTransactionCount.pluck().get() ?? 0;
	}
}
