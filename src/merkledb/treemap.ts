import { encodePacked, type Hex, keccak256, zeroHash } from "viem";

export class MerkleTreeMap<K> {
	#tree: Hex[][];
	#positions: Map<K, number>;

	constructor(leaves: [K, Hex][]) {
		const tree = [leaves.map(([, leaf]) => leaf)];
		while (true) {
			const row = tree.at(-1);
			if (row === undefined || row.length === 1) {
				break;
			}
			tree.push(
				Array(Math.ceil(row.length / 2))
					.fill(undefined)
					.map((_, i) => {
						const a = row.at(i * 2) ?? zeroHash;
						const b = row.at(i * 2 + 1) ?? zeroHash;
						const [left, right] = a < b ? [a, b] : [b, a];
						return keccak256(encodePacked(["bytes32", "bytes32"], [left, right]));
					}),
			);
		}

		this.#tree = tree;
		this.#positions = new Map(leaves.map(([address], i) => [address, i]));
	}

	root(): Hex {
		const [root] = this.#tree.at(-1) ?? [zeroHash];
		return root;
	}

	proof(key: K): Hex[] {
		const index = this.#positions.get(key);
		if (index === undefined) {
			throw new Error(`${key} not found`);
		}
		return this.#tree.slice(0, -1).map((row, j) => row.at((index >> j) ^ 1) ?? zeroHash);
	}
}
