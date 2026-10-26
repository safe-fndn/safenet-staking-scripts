/**
 * Command to pre-fetch events used by the accounting scripts and index them
 * into the database cache.
 */

import { AEGIS_PARAMETERS } from "../config/aegis.js";
import { Safenet } from "../safenet.js";
import { main } from "../utils/args.js";

main(async (args) => {
	const safenet = await Safenet.create({ ...args, ...AEGIS_PARAMETERS });
	await safenet.index();
});
