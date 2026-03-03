import debug, { type Debugger } from "debug";

export type Configuration = {
	delays: number[];
	debug: Debugger;
};

export const DEFAULT_CONFIGURATION = {
	delays: [200, 1000, 5000],
	debug: debug("safenet:backoff"),
};

export type Backoff = <T>(query: () => Promise<T>) => Promise<T>;

export const backoff = (config: Partial<Configuration> = {}): Backoff => {
	const { delays, debug } = { ...DEFAULT_CONFIGURATION, ...config };
	return async (query) => {
		for (const delay of delays) {
			try {
				return await query();
			} catch (err) {
				const msg = err instanceof Error ? err.message : "unknown error";
				debug(`query error (${msg}), trying again in ${delay / 1000}s`);
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
		return query();
	};
};
