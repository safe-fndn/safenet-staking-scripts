import { type Address, zeroAddress } from "viem";
import {
	and,
	call,
	delegatecall,
	exact,
	multisend,
	not,
	or,
	receive,
	self,
	targets,
} from "./combinators.js";

const ALLOWED = {
	fallbackHandlers: new Set<Address>([
		zeroAddress,
		"0x85a8ca358D388530ad0fB95D0cb89Dd44Fc242c3",
		"0x2f55e8b20D0B9FEFA187AA7d00B6Cbe563605bF5",
		"0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4",
		"0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99",
		"0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4",
		"0x017062a1dE2FE6b99BE3d9d37841FeD19F573804",
	]),
	guards: new Set<Address>([zeroAddress]),
	modules: new Set<Address>([]),
	moduleGuards: new Set<Address>([zeroAddress]),
};

const checkSingleTransaction = or(
	// Generally allow calls to other contracts.
	and(not(self), exact({ operation: 0 })),
	// Restrict allowed self calls.
	and(
		self,
		or(
			call({
				signature: "function addOwnerWithThreshold(address owner, uint256 threshold)",
			}),
			call({
				signature: "function removeOwner(address prevOwner, address owner, uint256 threshold)",
			}),
			call({
				signature: "function swapOwner(address prevOwner, address oldOwner, address newOwner)",
			}),
			call({
				signature: "function changeThreshold(uint256 threshold)",
			}),
			call({
				signature: "function setFallbackHandler(address handler)",
				args: ([handler]) => ALLOWED.fallbackHandlers.has(handler),
			}),
			call({
				signature: "function setGuard(address guard)",
				args: ([guard]) => ALLOWED.guards.has(guard),
			}),
			call({
				signature: "function enableModule(address module)",
				args: ([module]) => ALLOWED.modules.has(module),
			}),
			call({
				signature: "function disableModule(address prevModule, address module)",
			}),
			call({
				signature: "function setModuleGuard(address guard)",
				args: ([guard]) => ALLOWED.moduleGuards.has(guard),
			}),
			receive,
		),
	),
	// Selectively allow delegate calls to:
	// The SafeMigration contracts:
	and(
		targets(
			"0x6439e7ABD8Bb915A5263094784C5CF561c4172AC",
			"0x526643F69b81B008F46d95CD5ced5eC0edFFDaC6",
		),
		or(
			delegatecall({ signature: "function migrateSingleton()" }),
			delegatecall({ signature: "function migrateWithFallbackHandler()" }),
			delegatecall({ signature: "function migrateL2Singleton()" }),
			delegatecall({ signature: "function migrateL2WithFallbackHandler()" }),
		),
	),
	// The SignMessage contracts:
	and(
		targets(
			"0xA65387F16B013cf2Af4605Ad8aA5ec25a2cbA3a2",
			"0x98FFBBF51bb33A056B08ddf711f289936AafF717",
			"0xd53cd0aB83D845Ac265BE939c57F53AD838012c9",
			"0x4FfeF8222648872B3dE295Ba1e49110E61f5b5aa",
		),
		delegatecall({ signature: "function signMessage(bytes message)" }),
	),
);

export const checkTransaction = or(
	checkSingleTransaction,
	multisend({
		to: "0xA83c336B20401Af773B6219BA5027174338D1836",
		check: checkSingleTransaction,
		version: "v1.5.0+",
	}),
	multisend({ to: "0x9641d764fc13c8B624c04430C7356C1C7C8102e2", check: checkSingleTransaction }),
	multisend({ to: "0x40A2aCCbd92BCA938b02010E17A5b8929b49130D", check: checkSingleTransaction }),
);
