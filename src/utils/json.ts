import { z } from "zod";

/**
 * A JSON preprocessor to be used with Zod.
 */
export const jsonPreprocessor = (value: unknown, ctx: z.RefinementCtx): unknown => {
	if (typeof value !== "string") {
		return value;
	}

	try {
		return JSON.parse(value);
	} catch (err) {
		const message = err instanceof Error ? err.message : "unknown error";
		ctx.addIssue({
			code: "custom",
			message: `invalid JSON string: ${message}`,
		});
		return z.NEVER;
	}
};

/**
 * A JSON replacer that allows serializing `bigint`s as string quantities.
 */
export const jsonReplacer = (_key: string, value: unknown): unknown => {
	if (typeof value === "bigint") {
		return value.toString();
	}
	return value;
};
