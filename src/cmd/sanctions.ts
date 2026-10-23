/**
 * Command to print the list of sanctioned accounts considered for a payout period.
 */

import type { Address } from "viem";
import { AEGIS_PARAMETERS } from "../config/aegis.js";
import { Safenet } from "../safenet.js";
import { main } from "../utils/args.js";
import { addressColumn, createPresenter } from "../utils/presentation.js";

main(async (args) => {
	const safenet = await Safenet.create({ ...args, ...AEGIS_PARAMETERS });

	const presenter = createPresenter<Address>(
		[addressColumn({ header: "Account", extract: (account) => account })],
		args,
	);
	for (const account of await safenet.sanctionedAccounts()) {
		presenter.writeRow(account);
	}
	presenter.finish();
});
