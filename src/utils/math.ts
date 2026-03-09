export const maxBigInt = (a: bigint, b: bigint) => (a > b ? a : b);
export const minBigInt = (a: bigint, b: bigint) => (a < b ? a : b);

/**
 * Integer square root using Newton-Raphson iteration.
 */
export const sqrtBigInt = (n: bigint): bigint => {
	// Use Newton's method to converge to the square root.
	// See <https://en.wikipedia.org/wiki/Integer_square_root#Example_implementation>

	if (n < 0n) {
		throw new RangeError("square root of negative number");
	}
	if (n < 2n) {
		return n;
	}

	let a = 1n;
	let b = -1n;
	while (true) {
		const x = (a + n / a) / 2n;
		if (x === a) {
			return x;
		}
		if (x === b && x !== a) {
			return minBigInt(x, a);
		}

		b = a;
		a = x;
	}
};
