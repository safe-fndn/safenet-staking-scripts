import { encodePacked, type Hex, keccak256, zeroHash } from "viem";

export class MerkleTreeMap<K> {
	#tree: Hex[][];
	#positions: Map<K, number>;

	constructor(leaves: [K, Hex][]) {
		const tree = [leaves.map(([, leaf]) => leaf)];
		while (true) {
			const row = tree.at(-1);
			// An empty tree has no row to reduce, so stop at the leaves rather than reduce an
			// empty row forever.
			if (row === undefined || row.length <= 1) {
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

	/**
	 * The root of the tree. An empty tree has the zero root, which no proof can verify against,
	 * matching the `CumulativeMerkleDrop` contract before its first root is set.
	 */
	root(): Hex {
		return this.#tree.at(-1)?.at(0) ?? zeroHash;
	}

	proof(key: K): Hex[] | null {
		const index = this.#positions.get(key);
		if (index === undefined) {
			return null;
		}
		return this.#tree.slice(0, -1).map((row, j) => row.at((index >> j) ^ 1) ?? zeroHash);
	}
}
