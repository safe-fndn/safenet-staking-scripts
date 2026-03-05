import type { Statement } from "better-sqlite3";
import { type Address, getAbiItem, type Hex } from "viem";
import { z } from "zod";
import { COORDINATOR_ABI } from "../abi.js";
import { jsonPreprocessor, jsonReplacer } from "../utils/json.js";
import { type Configuration, EventIndexer, type ParsedLog } from "./events.js";

const EVENTS = [
	getAbiItem({ abi: COORDINATOR_ABI, name: "KeyGen" }),
	getAbiItem({ abi: COORDINATOR_ABI, name: "KeyGenCommitted" }),
	getAbiItem({ abi: COORDINATOR_ABI, name: "Sign" }),
	getAbiItem({ abi: COORDINATOR_ABI, name: "SignRevealedNonces" }),
	getAbiItem({ abi: COORDINATOR_ABI, name: "SignShared" }),
	getAbiItem({ abi: COORDINATOR_ABI, name: "SignCompleted" }),
];

export const SIGNATURE_SCHEMA = z.object({
	r: z.object({
		x: z.coerce.bigint(),
		y: z.coerce.bigint(),
	}),
	z: z.coerce.bigint(),
});

export type Signature = z.infer<typeof SIGNATURE_SCHEMA>;

export type Packet = {
	message: Hex;
	valid: boolean;
	attestation?: Signature;
};

type Group = {
	gid: Hex;
	count: number;
	threshold: number;
};

type GroupParticipant = {
	gid: Hex;
	identifier: bigint;
	participant: Address;
};

type SigningCeremony = {
	sid: Hex;
	gid: Hex;
	message: Hex;
};

type NoncesRevealed = {
	sid: Hex;
	identifier: bigint;
};

type SignatureShare = {
	sid: Hex;
	identifier: bigint;
	selectionRoot: Hex;
};

type SignatureComplete = {
	sid: Hex;
	selectionRoot: Hex;
	signature: string;
};

type SigningParticipation = {
	sid: Hex;
	selectionRoot: Hex | null;
	signature: string | null;
	threshold: number;
	participant: Address;
	noncesRevealed: 0 | 1;
	participantSelectionRoot: Hex | null;
};

export class Signatures extends EventIndexer<typeof EVENTS> {
	#queries: {
		upsertGroup: Statement<Group, number>;
		upsertGroupParticipant: Statement<GroupParticipant, number>;
		upsertSigningCeremony: Statement<SigningCeremony, number>;
		upsertSigningParticipantNoncesRevealed: Statement<NoncesRevealed, number>;
		upsertSigningParticipantShared: Statement<SignatureShare, number>;
		updateSigningCeremonyCompleted: Statement<SignatureComplete, number>;
		selectSigningParticipants: Statement<{ message: Hex }, SigningParticipation>;
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

			CREATE TABLE IF NOT EXISTS group_participants(
				contract TEXT NOT NULL,
				gid TEXT NOT NULL,
				identifier INTEGER NOT NULL,
				participant TEXT NOT NULL,
				PRIMARY KEY(contract, gid, identifier)
			);

			CREATE TABLE IF NOT EXISTS signing_ceremonies(
				contract TEXT NOT NULL,
				sid TEXT NOT NULL,
				gid TEXT NOT NULL,
				message TEXT NOT NULL,
				selection_root TEXT,
				signature TEXT,
				PRIMARY KEY(contract, sid)
			);
			CREATE INDEX IF NOT EXISTS signing_ceremony_message_idx
			ON signing_ceremonies(message);

			CREATE TABLE IF NOT EXISTS signing_participants(
				contract TEXT NOT NULL,
				sid TEXT NOT NULL,
				identifier INTEGER NOT NULL,
				nonces_revealed INTEGER NOT NULL,
				selection_root TEXT,
				PRIMARY KEY(contract, sid, identifier)
			);
		`);
		this.#queries = {
			upsertGroup: this.db.prepare<Group, number>(`
				INSERT INTO groups(contract, gid, count, threshold)
				VALUES('${this.contract}', @gid, @count, @threshold)
				ON CONFLICT(contract, gid)
				DO NOTHING
			`),
			upsertGroupParticipant: this.db.prepare<GroupParticipant, number>(`
				INSERT INTO group_participants(contract, gid, identifier, participant)
				VALUES('${this.contract}', @gid, @identifier, @participant)
				ON CONFLICT(contract, gid, identifier)
				DO NOTHING
			`),
			upsertSigningCeremony: this.db.prepare<SigningCeremony, number>(`
				INSERT INTO signing_ceremonies(contract, sid, gid, message, selection_root, signature)
				VALUES('${this.contract}', @sid, @gid, @message, NULL, NULL)
				ON CONFLICT(contract, sid)
				DO NOTHING
			`),
			upsertSigningParticipantNoncesRevealed: this.db.prepare<NoncesRevealed, number>(`
				INSERT INTO signing_participants(contract, sid, identifier, nonces_revealed, selection_root)
				VALUES('${this.contract}', @sid, @identifier, TRUE, NULL)
				ON CONFLICT(contract, sid, identifier)
				DO UPDATE SET nonces_revealed = EXCLUDED.nonces_revealed
			`),
			upsertSigningParticipantShared: this.db.prepare<SignatureShare, number>(`
				INSERT INTO signing_participants(contract, sid, identifier, nonces_revealed, selection_root)
				VALUES('${this.contract}', @sid, @identifier, FALSE, @selectionRoot)
				ON CONFLICT(contract, sid, identifier)
				DO UPDATE SET selection_root = EXCLUDED.selection_root
			`),
			updateSigningCeremonyCompleted: this.db.prepare<SignatureComplete, number>(`
				UPDATE signing_ceremonies
				SET selection_root = @selectionRoot
				, signature = @signature
				WHERE contract = '${this.contract}'
				AND sid = @sid
			`),
			selectSigningParticipants: this.db.prepare<{ message: Hex }, SigningParticipation>(`
				SELECT s.sid AS sid
				, s.selection_root AS selectionRoot
				, s.signature AS signature
				, g.threshold AS threshold
				, gp.participant AS participant
				, COALESCE(sp.nonces_revealed, FALSE) AS noncesRevealed
				, sp.selection_root AS participantSelectionRoot
				FROM signing_ceremonies AS s
				LEFT JOIN groups AS g
				ON g.contract = s.contract
				AND g.gid = s.gid
				LEFT JOIN group_participants AS gp
				ON gp.contract = s.contract
				AND gp.gid = s.gid
				LEFT JOIN signing_participants AS sp
				ON sp.contract = s.contract
				AND sp.sid = s.sid
				AND sp.identifier = gp.identifier
				WHERE s.contract = '${this.contract}'
				AND s.message = @message
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
			case "KeyGenCommitted": {
				this.#queries.upsertGroupParticipant.run({
					gid: log.args.gid,
					identifier: log.args.identifier,
					participant: log.args.participant,
				});
				break;
			}
			case "Sign": {
				this.#queries.upsertSigningCeremony.run({
					sid: log.args.sid,
					gid: log.args.gid,
					message: log.args.message,
				});
				break;
			}
			case "SignRevealedNonces": {
				this.#queries.upsertSigningParticipantNoncesRevealed.run({
					sid: log.args.sid,
					identifier: log.args.identifier,
				});
				break;
			}
			case "SignShared": {
				this.#queries.upsertSigningParticipantShared.run({
					sid: log.args.sid,
					identifier: log.args.identifier,
					selectionRoot: log.args.selectionRoot,
				});
				break;
			}
			case "SignCompleted": {
				this.#queries.updateSigningCeremonyCompleted.run({
					sid: log.args.sid,
					selectionRoot: log.args.selectionRoot,
					signature: JSON.stringify(log.args.signature, jsonReplacer),
				});
				break;
			}
		}
	}

	participants({ message, valid, attestation }: Packet): Address[] {
		const participation = this.#queries.selectSigningParticipants.all({ message }).map((p) => ({
			...p,
			signature: z.preprocess(jsonPreprocessor, SIGNATURE_SCHEMA.nullable()).parse(p.signature),
		}));

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
			const matching = new Set(
				participation
					.filter(
						(p) =>
							p.signature?.r.x === attestation.r.x &&
							p.signature?.r.y === attestation.r.y &&
							p.signature?.z === attestation.z,
					)
					.map((p) => p.sid),
			);
			if (matching.size !== 1) {
				throw new Error(
					`expected exactly one signing ceremony to match attestation, got ${matching.size}`,
				);
			}

			return participation
				.filter((p) => matching.has(p.sid) && p.selectionRoot === p.participantSelectionRoot)
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
}
