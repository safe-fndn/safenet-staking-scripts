import { describe, expect, it } from "vitest";
import { attestedTransaction } from "./harness/presets.js";
import { type ConsensusChainEvent, createTestSafenet, type Scenario } from "./harness/scenario.js";
import { emptyBlocks, namedAddress, parseSafe, signatureId } from "./harness/utils.js";

describe("settlement", () => {
	// A signing ceremony that completes, but whose `TransactionAttested` event
	// is placed in a later slot with `attestation`.
	const completedCeremony = (seed: string, participants: string[]): ConsensusChainEvent[] =>
		attestedTransaction({ epoch: 1n, seed, participants }).filter(
			({ name }) => name !== "TransactionAttested",
		);
	const attestation = (seed: string): ConsensusChainEvent => ({
		name: "TransactionAttested",
		sid: signatureId(seed, 1n),
	});

	// The period [60, 120] ends with block 25 (t=120), so it settles at block
	// 25 + 48 = 73 (t=360). The ceremonies are:
	//
	//   "1": completed and attested at t=60, inside the period
	//   "2": completed at t=65, attested at the settlement block (t=360)
	//   "3": completed at t=65, attested one block after it (t=365)
	//   "4": completed at t=65, attested after the period end but before the
	//        settlement block (t=200)
	//   "5": completed and attested at t=125, after the period end
	const scenario = ({ settled }: { settled: boolean }): Scenario => ({
		staking: {
			slots: [
				{
					events: [
						{
							name: "ValidatorUpdated",
							validator: namedAddress("alice"),
							isRegistered: true,
						},
						{
							name: "ValidatorUpdated",
							validator: namedAddress("bob"),
							isRegistered: true,
						},
						{
							name: "StakeIncreased",
							staker: namedAddress("aliceStaker"),
							validator: namedAddress("alice"),
							amount: parseSafe("1000000"),
						},
						{
							name: "StakeIncreased",
							staker: namedAddress("bobStaker"),
							validator: namedAddress("bob"),
							amount: parseSafe("1000000"),
						},
					],
				},
				// Up to the settlement timestamp, as every indexer is updated to it.
				...emptyBlocks(30, { assertTimestamp: 360n }),
			],
		},
		consensus: {
			slots: [
				{
					events: [
						{ name: "KeyGenConfirmed", participant: namedAddress("alice") },
						{ name: "KeyGenConfirmed", participant: namedAddress("bob") },
					],
				},
				...emptyBlocks(11),
				{
					assertTimestamp: 60n,
					events: attestedTransaction({ epoch: 1n, seed: "1", participants: ["alice", "bob"] }),
				},
				{
					assertTimestamp: 65n,
					events: [
						...completedCeremony("2", ["alice"]),
						...completedCeremony("3", ["bob"]),
						...completedCeremony("4", ["alice"]),
					],
				},
				...emptyBlocks(11, { assertTimestamp: 120n }),
				{
					assertTimestamp: 125n,
					events: attestedTransaction({ epoch: 1n, seed: "5", participants: ["bob"] }),
				},
				...emptyBlocks(14, { assertTimestamp: 195n }),
				{ assertTimestamp: 200n, events: [attestation("4")] },
				...emptyBlocks(31, { assertTimestamp: 355n }),
				...(settled
					? [
							{ assertTimestamp: 360n, events: [attestation("2")] },
							{ assertTimestamp: 365n, events: [attestation("3")] },
							...emptyBlocks(10, { assertTimestamp: 415n }),
						]
					: []),
			],
		},
	});
	const period = { fromTimestamp: 60n, toTimestamp: 120n };

	it("counts an attestation exactly at the settlement block", async () => {
		const safenet = await createTestSafenet(scenario({ settled: true }));

		expect(await safenet.settlement(period)).toEqual({
			boundaryBlock: 25n,
			settlementBlock: 73n,
			settlementTimestamp: 360n,
		});

		// Ceremony "2" was attested in the settlement block itself, so it counts
		// for alice, along with "1" and "4".
		const participation = await safenet.participation(period);
		expect(participation.total).toBe(3);
		expect(participation.validators[namedAddress("alice")]).toBe(3);
	});

	it("ignores an attestation after the settlement block however far the chain is indexed", async () => {
		// One database is only indexed as far as the settlement requires, the
		// other one up to the head of the chain, well past the attestation one
		// block after the settlement block. Note that the former still indexes
		// block 74, as it is part of the same block page as the settlement
		// block 73.
		const settled = await createTestSafenet(scenario({ settled: true }));
		const indexed = await createTestSafenet(scenario({ settled: true }));
		await indexed.index();

		// Of the ceremonies completed in the period, "3" was attested one block
		// after the settlement block, so it does not count. "5" completed after
		// the period end, so it does not count either, even though it was
		// attested well before the settlement block. That leaves "1", "2" and
		// "4": alice participated in all three, bob only in "1".
		const expected = {
			total: 3,
			validators: {
				[namedAddress("alice")]: 3,
				[namedAddress("bob")]: 1,
			},
		};
		expect(await settled.participation(period)).toEqual(expected);
		expect(await indexed.participation(period)).toEqual(expected);

		// bob's 1/3 participation is below the 75% threshold, so all rewards go
		// to alice's only staker. alice has no self-stake, so there is no
		// commission.
		const expectedRewards = {
			payouts: {
				[namedAddress("aliceStaker")]: {
					stakeRewards: parseSafe("100000"),
					commission: 0n,
					sentinelRewards: 0n,
				},
			},
			unpaid: 0n,
		};
		expect(await settled.rewards(period, parseSafe("100000"), 0n)).toEqual(expectedRewards);
		expect(await indexed.rewards(period, parseSafe("100000"), 0n)).toEqual(expectedRewards);
	});

	it("fails while the settlement block does not exist yet", async () => {
		// The chain ends with block 72, one block short of the settlement.
		const safenet = await createTestSafenet(scenario({ settled: false }));

		await expect(safenet.participation(period)).rejects.toThrow(
			"settlement block 73 does not exist yet",
		);
		await expect(safenet.rewards(period, parseSafe("100000"), 0n)).rejects.toThrow(
			"settlement block 73 does not exist yet",
		);
	});
});
