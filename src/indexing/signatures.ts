import type { Statement } from "better-sqlite3";
import { type Address, getAbiItem, type Hex } from "viem";
import { COORDINATOR_ABI } from "../abi.js";
import type { BlockRange, TimestampRange } from "../utils/ranges.js";
import { type Configuration, EventIndexer, type ParsedLog } from "./events.js";

const EVENTS = [
	getAbiItem({ abi: COORDINATOR_ABI, name: "KeyGenConfirmed" }),
	getAbiItem({ abi: COORDINATOR_ABI, name: "Sign" }),
	getAbiItem({ abi: COORDINATOR_ABI, name: "SignShared" }),
	getAbiItem({ abi: COORDINATOR_ABI, name: "SignCompleted" }),
];

export type ParticipationSummary = {
	total: number;
	participants: Record<Address, number>;
};

type Participant = {
	address: Address;
};

type Selection = {
	root: Address;
};

type SigningCeremony = {
	sid: Hex;
	blockNumber: bigint;
};

type SignatureShare = {
	sid: Hex;
	participant: Address;
	selectionRoot: Hex;
};

type SignatureComplete = {
	sid: Hex;
	selectionRoot: Hex;
	blockNumber: bigint;
};

type ParticipationCount = {
	participant: Address;
	count: number;
};

export class Signatures extends EventIndexer<typeof EVENTS> {
	#queries: {
		upsertParticipant: Statement<Participant, number>;
		upsertSelection: Statement<Selection, number>;
		deleteSelection: Statement<Selection, number>;
		insertSigningCeremony: Statement<SigningCeremony, number>;
		insertSigningParticipant: Statement<SignatureShare, number>;
		updateSigningCeremonyCompleted: Statement<SignatureComplete, number>;
		selectTotalSignatureCount: Statement<BlockRange, number>;
		selectParticipation: Statement<BlockRange, ParticipationCount>;
	};

	constructor(config: Configuration) {
		super({
			name: "signatures",
			events: EVENTS,
			...config,
		});

		this.db.exec(`
			CREATE TABLE IF NOT EXISTS participants(
				id INTEGER NOT NULL,
				address TEXT NOT NULL,
				PRIMARY KEY(id),
				UNIQUE(address)
			);

			CREATE TABLE IF NOT EXISTS selections(
				id INTEGER NOT NULL,
				root TEXT NOT NULL,
				PRIMARY KEY(id AUTOINCREMENT),
				UNIQUE(root)
			);

			CREATE TABLE IF NOT EXISTS signing_ceremonies(
				id INTEGER NOT NULL,
				sid TEXT NOT NULL,
				selection INTEGER,
				started_block_number INTEGER NOT NULL,
				completed_block_number INTEGER,
				PRIMARY KEY(id),
				UNIQUE(sid)
			);
			CREATE INDEX IF NOT EXISTS signing_ceremony_started_block_number_idx
			ON signing_ceremonies(started_block_number);

			CREATE TABLE IF NOT EXISTS signing_participants(
				ceremony INTEGER NOT NULL,
				participant INTEGER NOT NULL,
				selection INTEGER NOT NULL,
				PRIMARY KEY(ceremony, participant)
			) WITHOUT ROWID;
		`);
		this.#queries = {
			upsertParticipant: this.db.prepare<Participant, number>(`
				INSERT INTO participants(address)
				VALUES(@address)
				ON CONFLICT(address)
				DO NOTHING
			`),
			// We use a slightly different upsert pattern here that works better
			// with SQLite's `AUTOINCREMENT` (otherwise, we would increment row
			// IDs on every upsert, even if nothing was added to the table).
			upsertSelection: this.db.prepare<Selection, number>(`
				INSERT INTO selections(root)
				SELECT @root
				WHERE NOT EXISTS (SELECT 1 FROM selections WHERE root = @root)
			`),
			deleteSelection: this.db.prepare<Selection, number>(`
				DELETE FROM selections
				WHERE root = @root
			`),
			insertSigningCeremony: this.db.prepare<SigningCeremony, number>(`
				INSERT INTO signing_ceremonies(sid, selection, started_block_number, completed_block_number)
				VALUES(@sid, NULL, @blockNumber, NULL)
			`),
			insertSigningParticipant: this.db.prepare<SignatureShare, number>(`
				INSERT INTO signing_participants(ceremony, participant, selection)
				VALUES((SELECT id FROM signing_ceremonies WHERE sid = @sid)
				, (SELECT id FROM participants WHERE address = @participant)
				, (SELECT id FROM selections WHERE root = @selectionRoot))
			`),
			updateSigningCeremonyCompleted: this.db.prepare<SignatureComplete, number>(`
				UPDATE signing_ceremonies
				SET selection = (SELECT id FROM selections WHERE root = @selectionRoot)
				, completed_block_number = @blockNumber
				WHERE sid = @sid
			`),
			selectTotalSignatureCount: this.db.prepare<BlockRange, number>(`
				SELECT COUNT(*) AS count
				FROM signing_ceremonies
				WHERE selection IS NOT NULL
				AND started_block_number >= @fromBlock
				AND started_block_number <= @toBlock
			`),
			selectParticipation: this.db.prepare<BlockRange, ParticipationCount>(`
				SELECT a.address AS participant
				, COUNT(*) AS count
				FROM signing_ceremonies AS s
				INNER JOIN signing_participants AS p
				ON p.ceremony = s.id
				AND p.selection = s.selection
				INNER JOIN participants AS a
				ON a.id = p.participant
				WHERE s.selection IS NOT NULL
				AND s.started_block_number >= @fromBlock
				AND s.started_block_number <= @toBlock
				GROUP BY p.participant
			`),
		};
	}

	protected insertEvent(log: ParsedLog<typeof EVENTS>): void {
		switch (log.eventName) {
			case "KeyGenConfirmed": {
				this.#queries.upsertParticipant.run({
					address: log.args.participant,
				});
				break;
			}
			case "Sign": {
				this.#queries.insertSigningCeremony.run({
					sid: log.args.sid,
					blockNumber: log.blockNumber,
				});
				break;
			}
			case "SignShared": {
				this.#queries.upsertSelection.run({
					root: log.args.selectionRoot,
				});
				this.#queries.insertSigningParticipant.run({
					sid: log.args.sid,
					participant: log.args.participant,
					selectionRoot: log.args.selectionRoot,
				});
				break;
			}
			case "SignCompleted": {
				this.#queries.updateSigningCeremonyCompleted.run({
					sid: log.args.sid,
					selectionRoot: log.args.selectionRoot,
					blockNumber: log.blockNumber,
				});
				// We only care about whether or not a signing participant's
				// selection root matches the signatures, and not its actual
				// value. This allows us to use `AUTOINCREMENT` (which
				// guarantees that a row ID is never reused for the lifetime of
				// the database) and cleanup the selection root data from our
				// database to keep its size down. This _does_ mean that we end
				// up with dangling `selection` foreign keys, but this is OK
				// since we never care about the selection root value!
				this.#queries.deleteSelection.run({
					root: log.args.selectionRoot,
				});
				break;
			}
		}
	}

	async participation(period: TimestampRange): Promise<ParticipationSummary> {
		const range = await this.blocks.blockRange(period);
		const total = this.#queries.selectTotalSignatureCount.pluck().get(range) ?? 0;
		const counts = this.#queries.selectParticipation.all(range);
		const participants = Object.fromEntries(
			counts.map(({ participant, count }) => [participant, count]),
		);
		return {
			total,
			participants,
		};
	}
}
