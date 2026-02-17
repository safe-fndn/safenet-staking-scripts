import { parseAbi } from "viem";

export const CONSENSUS_FUNCTIONS = parseAbi([
	"function COORDINATOR() view returns (address coordinator)",
]);