import type { Address } from "viem";

export const sortByAddress = <T>(items: T[], selector: (item: T) => Address): T[] => {
	return items.sort((a, b) => {
		const aa = selector(a).toLowerCase();
		const bb = selector(b).toLowerCase();
		return aa === bb ? 0 : aa < bb ? -1 : 1;
	});
}
