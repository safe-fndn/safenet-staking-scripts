/**
 * The version module, which has no source: the Docker image build writes it as `dist/version.js`
 * next to the compiled code. Running from source, it does not exist.
 */

/** The full git commit hash the code was built from. */
export declare const GIT_COMMIT: string;
