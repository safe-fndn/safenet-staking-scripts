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

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const canonicalize = (value: Json, indent: string): string => {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	const inner = `${indent}\t`;
	const [open, close, members] = Array.isArray(value)
		? ["[", "]", value.map((item) => canonicalize(item, inner))]
		: [
				"{",
				"}",
				Object.keys(value)
					.sort()
					.map((key) => `${JSON.stringify(key)}: ${canonicalize(value[key], inner)}`),
			];
	if (members.length === 0) {
		return `${open}${close}`;
	}
	return `${open}\n${inner}${members.join(`,\n${inner}`)}\n${indent}${close}`;
};

/**
 * Serializes a value as canonical JSON, the format of the rewards DB: object keys recursively
 * sorted in JavaScript string order (UTF-16 code units, the default of `Array.prototype.sort`),
 * array order preserved, tab indentation, strings escaped as `JSON.stringify` escapes them, and a
 * trailing newline. Values are first converted as `JSON.stringify` does, with `bigint`s as decimal
 * strings, so for example `Date`s become ISO strings and `undefined` fields are dropped.
 */
export const canonicalJson = (value: unknown): string => {
	const json = JSON.stringify(value, jsonReplacer);
	if (json === undefined) {
		throw new Error("value cannot be serialized as JSON");
	}
	return `${canonicalize(JSON.parse(json), "")}\n`;
};

/**
 * Writes a value to a file as canonical JSON.
 */
export const writeJsonFile = async (path: string, value: unknown): Promise<void> => {
	await fs.writeFile(path, canonicalJson(value), "utf8");
};
