/**
 * Command to pre-fetch events used by the accounting scripts and index them
 * into the database cache.
 */

import { Safenet } from "../safenet.js";
import { main } from "./args.js";

main(async (args) => {
	const safenet = await Safenet.create(args);
	await safenet.index({ blockPageSize: args.blockPageSize });
});
