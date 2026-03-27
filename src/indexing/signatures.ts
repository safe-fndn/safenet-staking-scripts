import type { Statement } from "better-sqlite3";
import { type Address, getAbiItem, type Hex } from "viem";
import { COORDINATOR_ABI } from "../abi.js";
import type { BlockRange, TimestampRange } from "../utils/ranges.js";
import { type Configuration, EventIndexer, type ParsedLog } from "./events.js";

const EVENTS = [
	getAbiItem({ abi: COORDINATOR_ABI, name: "Sign" }),
	getAbiItem({ abi: COORDINATOR_ABI, name: "SignShared" }),
	getAbiItem({ abi: COORDINATOR_ABI, name: "SignCompleted" }),
];

export type ParticipationSummary = {
	total: number;
	participants: Record<Address, number>;
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
		upsertSigningCeremony: Statement<SigningCeremony, number>;
		upsertSigningParticipantShared: Statement<SignatureShare, number>;
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
			CREATE TABLE IF NOT EXISTS signing_ceremonies(
				contract TEXT NOT NULL,
				sid TEXT NOT NULL,
				selection_root TEXT,
				started_block_number INTEGER NOT NULL,
				completed_block_number INTEGER,
				PRIMARY KEY(contract, sid)
			);
			CREATE INDEX IF NOT EXISTS signing_ceremony_started_block_number_idx
			ON signing_ceremonies(started_block_number);

			CREATE TABLE IF NOT EXISTS signing_participants(
				contract TEXT NOT NULL,
				sid TEXT NOT NULL,
				participant TEXT NOT NULL,
				selection_root TEXT NOT NULL,
				PRIMARY KEY(contract, sid, participant)
			);
		`);
		this.#queries = {
			upsertSigningCeremony: this.db.prepare<SigningCeremony, number>(`
				INSERT INTO signing_ceremonies(contract, sid, selection_root, started_block_number, completed_block_number)
				VALUES('${this.contract}', @sid, NULL, @blockNumber, NULL)
				ON CONFLICT(contract, sid)
				DO NOTHING
			`),
			upsertSigningParticipantShared: this.db.prepare<SignatureShare, number>(`
				INSERT INTO signing_participants(contract, sid, participant, selection_root)
				VALUES('${this.contract}', @sid, @participant, @selectionRoot)
				ON CONFLICT(contract, sid, participant)
				DO NOTHING
			`),
			updateSigningCeremonyCompleted: this.db.prepare<SignatureComplete, number>(`
				UPDATE signing_ceremonies
				SET selection_root = @selectionRoot
				, completed_block_number = @blockNumber
				WHERE contract = '${this.contract}'
				AND sid = @sid
			`),
			selectTotalSignatureCount: this.db.prepare<BlockRange, number>(`
				SELECT COUNT(*) AS count
				FROM signing_ceremonies
				WHERE contract = '${this.contract}'
				AND started_block_number >= @fromBlock
				AND started_block_number <= @toBlock
				AND selection_root IS NOT NULL
			`),
			selectParticipation: this.db.prepare<BlockRange, ParticipationCount>(`
				SELECT p.participant AS participant
				, COUNT(*) AS count
				FROM signing_ceremonies AS s
				INNER JOIN signing_participants AS p
				ON p.contract = s.contract
				AND p.sid = s.sid
				AND p.selection_root = s.selection_root
				WHERE s.contract = '${this.contract}'
				AND s.started_block_number >= @fromBlock
				AND s.started_block_number <= @toBlock
				AND s.selection_root IS NOT NULL
				GROUP BY p.participant
			`),
		};
	}

	protected insertEvent(log: ParsedLog<typeof EVENTS>): void {
		switch (log.eventName) {
			case "Sign": {
				this.#queries.upsertSigningCeremony.run({
					sid: log.args.sid,
					blockNumber: log.blockNumber,
				});
				break;
			}
			case "SignShared": {
				this.#queries.upsertSigningParticipantShared.run({
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
