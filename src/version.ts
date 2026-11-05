/** This release. Kept equal to package.json's version (a test checks). */
export const VERSION = "1.0.0";

/**
 * The management API contract, reported by /connection and the manifest.
 * Raised only for a change that breaks existing callers. 3 is the first
 * public release (1 and 2 were pre-release).
 */
export const API_VERSION = 3;
