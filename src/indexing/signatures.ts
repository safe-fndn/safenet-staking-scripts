import type { Statement } from "better-sqlite3";
import { type Address, getAbiItem, type Hex } from "viem";
import { COORDINATOR_ABI } from "../abi.js";
import type { BlockRange, TimestampRange } from "../utils/ranges.js";
import { type Configuration, EventIndexer, type ParsedLog } from "./events.js";

const EVENTS = [
	getAbiItem({ abi: COORDINATOR_ABI, name: "KeyGen" }),
	getAbiItem({ abi: COORDINATOR_ABI, name: "Sign" }),
	getAbiItem({ abi: COORDINATOR_ABI, name: "SignRevealedNonces" }),
	getAbiItem({ abi: COORDINATOR_ABI, name: "SignShared" }),
	getAbiItem({ abi: COORDINATOR_ABI, name: "SignCompleted" }),
];

export type Packet = {
	message: Hex;
	valid: boolean;
	attestation?: Hex;
};

export type ParticipationSummary = {
	total: number;
	participants: Record<Address, number>;
};

type Group = {
	gid: Hex;
	count: number;
	threshold: number;
};

type SigningCeremony = {
	sid: Hex;
	gid: Hex;
	message: Hex;
	blockNumber: bigint;
};

type NoncesRevealed = {
	sid: Hex;
	participant: Address;
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

type SigningParticipation = {
	sid: Hex;
	selectionRoot: Hex | null;
	threshold: number;
	participant: Address;
	noncesRevealed: 0 | 1;
	participantSelectionRoot: Hex | null;
};

type ParticipationCount = {
	participant: Address;
	count: number;
};

export class Signatures extends EventIndexer<typeof EVENTS> {
	#queries: {
		upsertGroup: Statement<Group, number>;
		upsertSigningCeremony: Statement<SigningCeremony, number>;
		upsertSigningParticipantNoncesRevealed: Statement<NoncesRevealed, number>;
		upsertSigningParticipantShared: Statement<SignatureShare, number>;
		updateSigningCeremonyCompleted: Statement<SignatureComplete, number>;
		selectSigningParticipants: Statement<{ message: Hex }, SigningParticipation>;
		selectTotalSignatureCount: Statement<BlockRange, number>;
		selectApproximateParticipation: Statement<BlockRange, ParticipationCount>;
	};

	constructor(config: Configuration) {
		super({
			name: "signatures",
			events: EVENTS,
			...config,
		});

		this.db.exec(`
			CREATE TABLE IF NOT EXISTS groups(
				contract TEXT NOT NULL,
				gid TEXT NOT NULL,
				count INTEGER NOT NULL,
				threshold INTEGER NOT NULL,
				PRIMARY KEY(contract, gid)
			);

			CREATE TABLE IF NOT EXISTS signing_ceremonies(
				contract TEXT NOT NULL,
				sid TEXT NOT NULL,
				gid TEXT NOT NULL,
				message TEXT NOT NULL,
				selection_root TEXT,
				started_block_number INTEGER NOT NULL,
				completed_block_number INTEGER,
				PRIMARY KEY(contract, sid)
			);
			CREATE INDEX IF NOT EXISTS signing_ceremony_message_idx
			ON signing_ceremonies(message);
			CREATE INDEX IF NOT EXISTS signing_ceremony_started_block_number_idx
			ON signing_ceremonies(started_block_number);

			CREATE TABLE IF NOT EXISTS signing_participants(
				contract TEXT NOT NULL,
				sid TEXT NOT NULL,
				participant TEXT NOT NULL,
				nonces_revealed INTEGER NOT NULL,
				selection_root TEXT,
				PRIMARY KEY(contract, sid, participant)
			);
		`);
		this.#queries = {
			upsertGroup: this.db.prepare<Group, number>(`
				INSERT INTO groups(contract, gid, count, threshold)
				VALUES('${this.contract}', @gid, @count, @threshold)
				ON CONFLICT(contract, gid)
				DO NOTHING
			`),
			upsertSigningCeremony: this.db.prepare<SigningCeremony, number>(`
				INSERT INTO signing_ceremonies(contract, sid, gid, message, selection_root, started_block_number, completed_block_number)
				VALUES('${this.contract}', @sid, @gid, @message, NULL, @blockNumber, NULL)
				ON CONFLICT(contract, sid)
				DO NOTHING
			`),
			upsertSigningParticipantNoncesRevealed: this.db.prepare<NoncesRevealed, number>(`
				INSERT INTO signing_participants(contract, sid, participant, nonces_revealed, selection_root)
				VALUES('${this.contract}', @sid, @participant, TRUE, NULL)
				ON CONFLICT(contract, sid, participant)
				DO UPDATE SET nonces_revealed = EXCLUDED.nonces_revealed
			`),
			upsertSigningParticipantShared: this.db.prepare<SignatureShare, number>(`
				INSERT INTO signing_participants(contract, sid, participant, nonces_revealed, selection_root)
				VALUES('${this.contract}', @sid, @participant, FALSE, @selectionRoot)
				ON CONFLICT(contract, sid, participant)
				DO UPDATE SET selection_root = EXCLUDED.selection_root
			`),
			updateSigningCeremonyCompleted: this.db.prepare<SignatureComplete, number>(`
				UPDATE signing_ceremonies
				SET selection_root = @selectionRoot
				, completed_block_number = @blockNumber
				WHERE contract = '${this.contract}'
				AND sid = @sid
			`),
			selectSigningParticipants: this.db.prepare<{ message: Hex }, SigningParticipation>(`
				SELECT s.sid AS sid
				, s.selection_root AS selectionRoot
				, g.threshold AS threshold
				, p.participant AS participant
				, COALESCE(p.nonces_revealed, FALSE) AS noncesRevealed
				, p.selection_root AS participantSelectionRoot
				FROM signing_ceremonies AS s
				INNER JOIN groups AS g
				ON g.contract = s.contract
				AND g.gid = s.gid
				INNER JOIN signing_participants AS p
				ON p.contract = s.contract
				AND p.sid = s.sid
				WHERE s.contract = '${this.contract}'
				AND s.message = @message
			`),
			selectTotalSignatureCount: this.db.prepare<BlockRange, number>(`
				SELECT COUNT(*) AS count
				FROM signing_ceremonies
				WHERE contract = '${this.contract}'
				AND started_block_number >= @fromBlock
				AND started_block_number <= @toBlock
				AND selection_root IS NOT NULL
			`),
			selectApproximateParticipation: this.db.prepare<BlockRange, ParticipationCount>(`
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
			case "KeyGen": {
				this.#queries.upsertGroup.run({
					gid: log.args.gid,
					count: log.args.count,
					threshold: log.args.threshold,
				});
				break;
			}
			case "Sign": {
				this.#queries.upsertSigningCeremony.run({
					sid: log.args.sid,
					gid: log.args.gid,
					message: log.args.message,
					blockNumber: log.blockNumber,
				});
				break;
			}
			case "SignRevealedNonces": {
				this.#queries.upsertSigningParticipantNoncesRevealed.run({
					sid: log.args.sid,
					participant: log.args.participant,
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

	participants({ message, valid, attestation }: Packet): Address[] {
		const participation = this.#queries.selectSigningParticipants.all({ message });

		// We have a few different definitions of participation, depending on
		// the outcompe of the packet:
		if (!valid) {
			// If the packet isn't valid, then only those who did not
			// participate at all are counted.
			const participants = new Set(participation.map((p) => p.participant));
			for (const { participant, noncesRevealed, participantSelectionRoot } of participation) {
				if (noncesRevealed || participantSelectionRoot !== null) {
					participants.delete(participant);
				}
			}
			return [...participants];
		} else if (attestation) {
			// If an attestation was produced, then only consider those who
			// participated in ceremony that produced the matching signature.
			return participation
				.filter((p) => p.sid === attestation && p.selectionRoot === p.participantSelectionRoot)
				.map((p) => p.participant);
		} else {
			// There is a valid packet, but no attestation was produced (for
			// example, if the network is down). The only way to reliably
			// determine which parties participated honestly, would be to replay
			// the consensus state-machine and deduce who was good and who was
			// bad. For now, we will try and figure out the participants
			// heuristically and just return no one in case we can't.
			// Specifically, we will start by handling the case where there was
			// a single signing ceremony attempt which failed because not enough
			// people showed up: either not enough nonces were revealed, or not
			// everyone that commited shared.
			const giveUp = () => {
				console.warn(`WARNING: could not determinie participants for ${message}`);
				return [];
			};

			const sids = new Set(participation.map((p) => p.sid));
			if (sids.size !== 1) {
				return giveUp();
			}

			const threshold = participation[0].threshold;
			const revealed = participation.filter((p) => p.noncesRevealed);
			if (revealed.length >= threshold) {
				const selectionRoots = Object.entries(
					participation.reduce(
						(acc, p) => {
							const sr = p.participantSelectionRoot;
							if (sr !== null) {
								acc[sr] = (acc[sr] ?? 0) + 1;
							}
							return acc;
						},
						{} as Record<string, number>,
					),
				)
					.sort(([, a], [, b]) => b - a)
					.map(([selectionRoot, count]) => ({ selectionRoot, count }));

				if (selectionRoots.length === 0) {
					// No one shared, even if there were sufficient revealed
					// nonce pairs: no one participated.
					return [];
				} else if (
					selectionRoots.length === 1 ||
					selectionRoots[0].count > selectionRoots[1].count
				) {
					// We have a selection root that is most popular, so only
					// count participants from that.
					const popular = selectionRoots[0].selectionRoot;
					return participation.filter((p) => p.selectionRoot === popular).map((p) => p.participant);
				} else {
					return giveUp();
				}
			} else {
				// Not enough participants were included
				return revealed.map((p) => p.participant);
			}
		}
	}

	async approximateParticipation(period: TimestampRange): Promise<ParticipationSummary> {
		const range = await this.blocks.blockRange(period);
		const total = this.#queries.selectTotalSignatureCount.pluck().get(range) ?? 0;
		const counts = this.#queries.selectApproximateParticipation.all(range);
		const participants = Object.fromEntries(
			counts.map(({ participant, count }) => [participant, count]),
		);
		return {
			total,
			participants,
		};
	}
}
