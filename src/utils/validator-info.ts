import path from "node:path";
import { getAddress } from "viem";
import { z } from "zod";
import type { Participation } from "../safenet.js";
import { readJsonFile, writeJsonFile } from "./json.js";
import { sortByAddress } from "./sort.js";

/**
 * Records validator participation rates into `<record>/assets/validator-info.json`.
 *
 * A period without attested transactions has no rates (`0 / 0` is `NaN`, which
 * JSON writes as `null`), so the file is left untouched and `false` is returned.
 */
export const recordParticipation = async (
	record: string,
	{ total, validators }: Participation,
): Promise<boolean> => {
	if (total === 0) {
		return false;
	}

	const validatorsFile = path.join(record, "assets", "validator-info.json");
	const data = await readJsonFile(
		validatorsFile,
		z
			.looseObject({
				address: z.string().transform((s) => getAddress(s)),
				// Older versions wrote `null` for empty periods; accept it so that
				// the next period with transactions replaces it.
				participation_rate_14d: z.number().nullable(),
			})
			.array(),
	);

	for (const [validator, count] of Object.entries(validators)) {
		const participationRate = count / total;
		const info = data.find(({ address }) => address === validator);
		if (info !== undefined) {
			info.participation_rate_14d = participationRate;
		} else {
			data.push({
				address: getAddress(validator),
				participation_rate_14d: participationRate,
			});
		}
	}

	sortByAddress(data, (info) => info.address);
	await writeJsonFile(validatorsFile, data);
	return true;
};
