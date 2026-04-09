/**
 * Command to print the list of sanctioned accounts considered for a payout period.
 */

import { Safenet } from "../safenet.js";
import { main } from "../utils/args.js";

main(async (args) => {
	const safenet = await Safenet.create(args);

	console.log(` Account`);
	console.log(`--------------------------------------------`);
	for (const account of await safenet.sanctionedAccounts()) {
		console.log(` ${account}`);
	}
});
