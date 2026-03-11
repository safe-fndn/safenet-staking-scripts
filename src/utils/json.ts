import { promises as fs } from "node:fs";
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

/**
 * Reads and parses a JSON file with Zod.
 */
export const readJsonFile = async <T>(path: string, schema: z.ZodType<T>): Promise<T> => {
	const json = await fs.readFile(path, "utf8");
	return z.preprocess(jsonPreprocessor, schema).parse(json);
};

/**
 * Writes to a JSON file.
 */
export const writeJsonFile = async (path: string, value: unknown): Promise<void> => {
	const json = `${JSON.stringify(value, jsonReplacer, "\t")}\n`;
	await fs.writeFile(path, json, "utf8");
};
