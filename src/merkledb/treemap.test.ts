import { encodePacked, type Hex, keccak256, toHex, zeroHash } from "viem";
import { describe, expect, it } from "vitest";
import { MerkleTreeMap } from "./treemap.js";

const leaf = (key: string): [string, Hex] => [key, keccak256(toHex(key))];

// Sorted-pair verification, as done by OpenZeppelin's `MerkleProof` that the onchain
// `CumulativeMerkleDrop` contract uses.
const verify = (proof: Hex[], root: Hex, node: Hex): boolean =>
	proof.reduce((hash, sibling) => {
		const [left, right] = hash < sibling ? [hash, sibling] : [sibling, hash];
		return keccak256(encodePacked(["bytes32", "bytes32"], [left, right]));
	}, node) === root;

describe("MerkleTreeMap", () => {
	it.concurrent("has a zero root and no proofs when empty", () => {
		const tree = new MerkleTreeMap<string>([]);
		expect(tree.root()).toBe(zeroHash);
		expect(tree.proof("absent")).toBeNull();
	});

	it.concurrent("uses the leaf as the root of a single leaf tree", () => {
		const [key, node] = leaf("a");
		const tree = new MerkleTreeMap([[key, node]]);
		expect(tree.root()).toBe(node);
		expect(tree.proof(key)).toEqual([]);
		expect(tree.proof("absent")).toBeNull();
	});

	it.concurrent("produces proofs that verify against the root", () => {
		const leaves = ["a", "b", "c", "d", "e"].map(leaf);
		const tree = new MerkleTreeMap(leaves);
		for (const [key, node] of leaves) {
			const proof = tree.proof(key);
			expect(proof).not.toBeNull();
			expect(verify(proof ?? [], tree.root(), node)).toBe(true);
		}
		expect(tree.proof("absent")).toBeNull();
	});
});
