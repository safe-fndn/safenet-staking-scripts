import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeJsonFile } from "../src/utils/json.js";
import { recordParticipation } from "../src/utils/validator-info.js";
import { attestedTransaction } from "./harness/presets.js";
import { createTestSafenet } from "./harness/scenario.js";
import { emptyBlocks, namedAddress } from "./harness/utils.js";

const records = [] as string[];

const validatorsFile = (record: string) => path.join(record, "assets", "validator-info.json");

/**
 * Creates a temporary record directory holding the given `validator-info.json` entries.
 */
const createRecord = async (validators: Record<string, unknown>[]): Promise<string> => {
	const record = await fs.mkdtemp(path.join(os.tmpdir(), "safenet-participation-"));
	records.push(record);
	await fs.mkdir(path.join(record, "assets"), { recursive: true });
	await writeJsonFile(validatorsFile(record), validators);
	return record;
};

// A single validator, signing the only attested transaction at t=60.
const createSafenet = () =>
	createTestSafenet({
		staking: {
			slots: [
				{
					events: [
						{
							name: "ValidatorUpdated",
							validator: namedAddress("validator"),
							isRegistered: true,
						},
					],
				},
				...emptyBlocks(10, { assertTimestamp: 120n }),
			],
		},
		consensus: {
			slots: [
				{
					events: [{ name: "KeyGenConfirmed", participant: namedAddress("validator") }],
				},
				...emptyBlocks(11),
				{
					assertTimestamp: 60n,
					events: attestedTransaction({ epoch: 1n, seed: "1", participants: ["validator"] }),
				},
				...emptyBlocks(12, { assertTimestamp: 120n }),
			],
		},
	});

afterEach(async () => {
	for (const record of records.splice(0)) {
		await fs.rm(record, { recursive: true, force: true });
	}
});

describe("participation record", () => {
	it("keeps the recorded rates for a period without attested transactions", async () => {
		const safenet = await createSafenet();
		const record = await createRecord([
			{
				address: namedAddress("validator"),
				label: "Validator",
				participation_rate_14d: 0.9,
			},
		]);
		const before = await fs.readFile(validatorsFile(record), "utf8");

		const participation = await safenet.participation({ fromTimestamp: 65n, toTimestamp: 120n });
		expect(participation).toEqual({ total: 0, validators: { [namedAddress("validator")]: 0 } });

		expect(await recordParticipation(record, participation)).toBe(false);
		expect(await fs.readFile(validatorsFile(record), "utf8")).toBe(before);
	});

	it("replaces a null rate left by an empty period", async () => {
		const safenet = await createSafenet();
		const record = await createRecord([
			{
				address: namedAddress("validator"),
				label: "Validator",
				participation_rate_14d: null,
			},
		]);

		const participation = await safenet.participation({ fromTimestamp: 60n, toTimestamp: 120n });
		expect(await recordParticipation(record, participation)).toBe(true);
		expect(JSON.parse(await fs.readFile(validatorsFile(record), "utf8"))).toEqual([
			{
				address: namedAddress("validator"),
				label: "Validator",
				participation_rate_14d: 1,
			},
		]);
	});

	it("inserts a validator missing from the file, sorted by address", async () => {
		const safenet = await createSafenet();
		const last = {
			address: "0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF",
			participation_rate_14d: 0.5,
		};
		const record = await createRecord([last]);

		const participation = await safenet.participation({ fromTimestamp: 60n, toTimestamp: 120n });
		expect(await recordParticipation(record, participation)).toBe(true);
		expect(JSON.parse(await fs.readFile(validatorsFile(record), "utf8"))).toEqual([
			{ address: namedAddress("validator"), participation_rate_14d: 1 },
			last,
		]);
	});
});
