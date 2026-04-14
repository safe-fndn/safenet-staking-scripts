/**
 * Pre-seeded validator beneficiaries data to avoid indexing from the beginning
 * of time.
 */

export type ValidatorBeneficiariesSeedData = {
	lastUpdatedBlock: {
		number: bigint;
		timestamp: bigint;
	};
};

export const VALIDATOR_BENEFICIARIES_SEED_DATA = {
	"1:0x469788fE6E9E9681C6ebF3bF78e7Fd26Fc015446": {
		lastUpdatedBlock: {
			number: 24878000n,
			timestamp: 1776169307n,
		},
	},
} as Record<string, ValidatorBeneficiariesSeedData | undefined>;
