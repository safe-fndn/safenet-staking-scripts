/**
 * Fetches sanctioned addresses published by the `sanctions-address-lists`
 * project <https://github.com/safe-research/sanctions-address-lists>, which
 * extracts EVM addresses from the UN, EU, UK, Swiss SECO and US OFAC
 * sanctions lists and republishes them as stable release assets.
 */

import debug from "debug";
import { type Address, getAddress, isAddress } from "viem";
import { z } from "zod";
import { type Backoff, backoff } from "./utils/backoff.js";

/** Per-jurisdiction source identifiers, matching the release asset file names. */
const SOURCES = ["un", "eu", "uk", "ch-seco", "us-ofac"] as const;

export const DEFAULT_SANCTIONS_ADDRESS_LISTS_URL =
	"https://github.com/safe-research/sanctions-address-lists/releases/download/latest";

export type SanctionsAddressListsConfiguration = {
	/** Base URL that per-source `<source>.json` address lists are fetched from. */
	baseUrl: string;
};

const zAddressList = z.array(z.string());

export class SanctionsAddressLists {
	#baseUrl: string;
	#backoff: Backoff;

	constructor({ baseUrl }: Partial<SanctionsAddressListsConfiguration> = {}) {
		this.#baseUrl = baseUrl ?? DEFAULT_SANCTIONS_ADDRESS_LISTS_URL;
		this.#backoff = backoff({ debug: debug("safenet:sanctions-lists") });
	}

	async #fetchSource(source: string): Promise<Address[]> {
		const url = `${this.#baseUrl}/${source}.json`;
		const body = await this.#backoff(async () => {
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`failed to fetch '${url}': ${response.status} ${response.statusText}`);
			}
			return await response.json();
		});

		// The published lists are address-only screening: addresses are only
		// included when explicitly published by the official source, never
		// inferred from names or enriched from third parties. We additionally
		// filter out anything that does not parse as an address here, in case a
		// future format revision mixes in metadata we do not expect.
		return zAddressList
			.parse(body)
			.filter((address) => isAddress(address))
			.map((address) => getAddress(address));
	}

	/**
	 * Fetches and merges the UN, EU, UK, Swiss SECO and US OFAC address lists.
	 *
	 * There is no onchain timestamp to pin these lists to, so unlike the
	 * Chainalysis oracle in `src/indexing/sanctions.ts`, this always reflects
	 * the latest published lists rather than their state at a point in time.
	 */
	async accounts(): Promise<Address[]> {
		const lists = await Promise.all(SOURCES.map((source) => this.#fetchSource(source)));
		return [...new Set(lists.flat())];
	}
}
