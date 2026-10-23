import { getAddress, zeroAddress } from "viem";
import { normalize } from "viem/ens";
import { describe, expect, it } from "vitest";
import { zGitHubRepository } from "../utils/gh.js";
import { AEGIS } from "./aegis.js";

describe("AEGIS", () => {
	const { ethereum, gnosis } = AEGIS;
	const indexed = { ...ethereum, ...gnosis };
	const contracts = {
		staking: ethereum.staking.address,
		delegateRegistry: ethereum.delegateRegistry.address,
		sanctionsList: ethereum.sanctionsList.address,
		cumulativeMerkleDrop: ethereum.cumulativeMerkleDrop,
		realityModule: ethereum.realityModule,
		consensus: gnosis.consensus.address,
		sentinelOracle: gnosis.sentinelOracle.address,
	};

	it.each(Object.entries(contracts))("has a checksummed %s address", (_, address) => {
		expect(address).toBe(getAddress(address));
		expect(address).not.toBe(zeroAddress);
	});

	it("has distinct addresses", () => {
		const addresses = Object.values(contracts);
		expect(new Set(addresses).size).toBe(addresses.length);
	});

	it.each([
		"staking",
		"delegateRegistry",
		"sanctionsList",
		"consensus",
		"sentinelOracle",
	] as const)("starts indexing %s at a non-zero block", (name) => {
		expect(indexed[name].startBlock).toBeGreaterThan(0n);
	});

	it("deployed the sentinel oracle after the consensus contract", () => {
		expect(gnosis.sentinelOracle.startBlock).toBeGreaterThanOrEqual(gnosis.consensus.startBlock);
	});

	it("has a normalized ENS name", () => {
		expect(normalize(ethereum.rewardsEnsName)).toBe(ethereum.rewardsEnsName);
	});

	it("has a valid sanctions lists repository", () => {
		expect(zGitHubRepository.parse(AEGIS.sanctionsAddressRepo)).toBe(AEGIS.sanctionsAddressRepo);
	});
});
