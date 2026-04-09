import type { Database, Statement } from "better-sqlite3";
import type { Address, Hex } from "viem";
import type { TimestampRange } from "../utils/ranges.js";
import type { Configuration } from "./events.js";

export type AttestationsIndexerConfiguration = {
	attestations: Attestations;
} & Configuration;

export type ParticipationSummary = {
	total: number;
	participants: Record<Address, number>;
};

export type Participant = {
	address: Address;
};

export type SigningCeremony = {
	sid: Hex;
};

export type SignatureShare = {
	sid: Hex;
	participant: Address;
	selectionRoot: Hex;
};

type SigningCeremonyDetails = SigningCeremony & {
	isTransactionAttestation: 0 | 1 | null;
};

type SignatureComplete = {
	sid: Hex;
	selectionRoot: Hex;
	blockTimestamp: bigint;
};

type Selection = {
	root: Address;
};

type ParticipationCount = {
	participant: Address;
	count: number;
};

export class Attestations {
	#db: Database;
	#queries: {
		upsertIncrementTransactionCount: Statement<[], number>;
		selectTransactionCount: Statement<[], number>;
		upsertParticipant: Statement<Participant, number>;
		upsertSelection: Statement<Selection, number>;
		deleteSelection: Statement<Selection, number>;
		upsertSigningCeremony: Statement<SigningCeremonyDetails, number>;
		insertSigningParticipant: Statement<SignatureShare, number>;
		updateSigningCeremonyCompleted: Statement<SignatureComplete, number>;
		selectTotalSignatureCount: Statement<TimestampRange, number>;
		selectParticipation: Statement<TimestampRange, ParticipationCount>;
	};

	constructor({ db }: { db: Database }) {
		this.#db = db;
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS transactions(
				id TEXT NOT NULL,
				cnt INTEGER NOT NULL,
				PRIMARY KEY(id),
				CHECK(id = 0)
			);

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
				completed_block_timestamp INTEGER,
				is_transaction_attestation INTEGER NOT NULL,
				PRIMARY KEY(id),
				UNIQUE(sid)
			);
			CREATE INDEX IF NOT EXISTS signing_ceremony_completed_block_timestamp_idx
			ON signing_ceremonies(completed_block_timestamp);
			CREATE INDEX IF NOT EXISTS signing_ceremony_is_transaction_attestation_idx
			ON signing_ceremonies(is_transaction_attestation);

			CREATE TABLE IF NOT EXISTS signing_participants(
				ceremony INTEGER NOT NULL,
				participant INTEGER NOT NULL,
				selection INTEGER NOT NULL,
				PRIMARY KEY(ceremony, participant)
			) WITHOUT ROWID;
		`);
		this.#queries = {
			upsertIncrementTransactionCount: this.#db.prepare<[], number>(`
				INSERT INTO transactions(id, cnt)
				VALUES(0, 1)
				ON CONFLICT(id)
				DO UPDATE SET cnt = cnt + 1
			`),
			upsertParticipant: this.#db.prepare<Participant, number>(`
				INSERT INTO participants(address)
				VALUES(@address)
				ON CONFLICT(address)
				DO NOTHING
			`),
			// We use a slightly different upsert pattern here that works better
			// with SQLite's `AUTOINCREMENT` (otherwise, we would increment row
			// IDs on every upsert, even if nothing was added to the table).
			upsertSelection: this.#db.prepare<Selection, number>(`
				INSERT INTO selections(root)
				SELECT @root
				WHERE NOT EXISTS (SELECT 1 FROM selections WHERE root = @root)
			`),
			deleteSelection: this.#db.prepare<Selection, number>(`
				DELETE FROM selections
				WHERE root = @root
			`),
			upsertSigningCeremony: this.#db.prepare<SigningCeremonyDetails, number>(`
				INSERT INTO signing_ceremonies(sid, selection, completed_block_timestamp, is_transaction_attestation)
				VALUES(@sid, NULL, NULL, COALESCE(@isTransactionAttestation, FALSE))
				ON CONFLICT DO UPDATE
				SET is_transaction_attestation = COALESCE(@isTransactionAttestation, is_transaction_attestation)
			`),
			insertSigningParticipant: this.#db.prepare<SignatureShare, number>(`
				INSERT INTO signing_participants(ceremony, participant, selection)
				VALUES((SELECT id FROM signing_ceremonies WHERE sid = @sid)
				, (SELECT id FROM participants WHERE address = @participant)
				, (SELECT id FROM selections WHERE root = @selectionRoot))
			`),
			updateSigningCeremonyCompleted: this.#db.prepare<SignatureComplete, number>(`
				UPDATE signing_ceremonies
				SET selection = (SELECT id FROM selections WHERE root = @selectionRoot)
				, completed_block_timestamp = @blockTimestamp
				WHERE sid = @sid
			`),
			selectTransactionCount: this.#db.prepare<[], number>(`
				SELECT cnt
				FROM transactions
				WHERE id = 0
			`),
			selectTotalSignatureCount: this.#db.prepare<TimestampRange, number>(`
				SELECT COUNT(*) AS count
				FROM signing_ceremonies
				WHERE selection IS NOT NULL
				AND completed_block_timestamp >= @fromTimestamp
				AND completed_block_timestamp <= @toTimestamp
				AND is_transaction_attestation = TRUE
			`),
			selectParticipation: this.#db.prepare<TimestampRange, ParticipationCount>(`
				SELECT a.address AS participant
				, COUNT(*) AS count
				FROM signing_ceremonies AS s
				INNER JOIN signing_participants AS p
				ON p.ceremony = s.id
				AND p.selection = s.selection
				INNER JOIN participants AS a
				ON a.id = p.participant
				WHERE s.selection IS NOT NULL
				AND s.completed_block_timestamp >= @fromTimestamp
				AND s.completed_block_timestamp <= @toTimestamp
				AND is_transaction_attestation = TRUE
				GROUP BY p.participant
			`),
		};
	}

	registerTransactionProposal(): void {
		this.#queries.upsertIncrementTransactionCount.run();
	}

	registerParticipant({ address }: Participant): void {
		this.#queries.upsertParticipant.run({ address });
	}

	registerSigningCeremony({ sid }: SigningCeremony): void {
		this.#queries.upsertSigningCeremony.run({
			sid,
			isTransactionAttestation: null,
		});
	}

	registerSignatureShare({ sid, participant, selectionRoot }: SignatureShare): void {
		this.#queries.upsertSelection.run({ root: selectionRoot });
		this.#queries.insertSigningParticipant.run({ sid, participant, selectionRoot });
	}

	registerSignatureCompleted({ sid, selectionRoot, blockTimestamp }: SignatureComplete): void {
		this.#queries.updateSigningCeremonyCompleted.run({ sid, selectionRoot, blockTimestamp });

		// We only care about whether or not a signing participant's selection
		// root matches the signatures, and not its actual value. This allows us
		// to use `AUTOINCREMENT` (which guarantees that a row ID is never reused
		// for the lifetime of the database) and cleanup the selection root data
		// from our database to keep its size down. This _does_ mean that we end
		// up with dangling `selection` foreign keys, but this is OK since we
		// never care about the selection root value!
		this.#queries.deleteSelection.run({ root: selectionRoot });
	}

	registerTransactionAttestation({ sid }: SigningCeremony) {
		// Note that we upsert here instead of just `UPDATE`-ing the row, these
		// events are driven by different indexers which means that it may come
		// out of order with the corresponding `registerSigningCeremony`.
		this.#queries.upsertSigningCeremony.run({
			sid,
			isTransactionAttestation: 1,
		});
	}

	transactionCount(): number {
		return this.#queries.selectTransactionCount.pluck().get() ?? 0;
	}

	participation(period: TimestampRange): ParticipationSummary {
		const total = this.#queries.selectTotalSignatureCount.pluck().get(period) ?? 0;
		const counts = this.#queries.selectParticipation.all(period);
		const participants = Object.fromEntries(
			counts.map(({ participant, count }) => [participant, count]),
		);
		return {
			total,
			participants,
		};
	}
}
