// Keys and ids. Every key is `<prefix><id>_<secret>`: the id is the lookup,
// the whole key is hashed with SHA-256 (the secret is 256 random bits, so a
// fast hash is enough), and only the hash is stored.

export const ADMIN_PREFIX = "wcha_";
export const INGEST_PREFIX = "wchi_";
export const ACCESS_PREFIX = "wchm_";

/** Shorter admin keys are refused, so a weak one can't be deployed by mistake. */
export const ADMIN_KEY_MIN_LENGTH = 32;

/** How many characters of a key are kept to tell keys apart. */
const DISPLAY_PREFIX_LENGTH = 16;

export function randomHex(bytes: number): string {
	return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** `<prefix>_<24 hex>`, e.g. `egp_1a2b…`. */
export function newId(prefix: string): string {
	return `${prefix}_${randomHex(12)}`;
}

/** A new key and what to store for it. */
export async function newKey(prefix: string, id: string) {
	const key = `${prefix}${id}_${randomHex(32)}`;
	return { key, hash: await sha256Hex(key), displayPrefix: key.slice(0, DISPLAY_PREFIX_LENGTH) };
}

/** The id inside `<prefix><id>_<secret>`, or null when malformed. Ids contain `_`; secrets don't. */
export function keyId(key: string, prefix: string): string | null {
	if (!key.startsWith(prefix)) return null;
	const rest = key.slice(prefix.length);
	const split = rest.lastIndexOf("_");
	if (split <= 0 || split === rest.length - 1) return null;
	return rest.slice(0, split);
}

export async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return toHex(new Uint8Array(digest));
}

/** Compares two strings in constant time, whatever their lengths. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
	const [x, y] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
	let diff = 0;
	for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
	return diff === 0;
}

/** The configured admin key, or null when it's missing or too weak to use. */
export function adminKeyOf(env: { FEEDBAKKR_WATCH_ADMIN_KEY?: string }): string | null {
	const key = env.FEEDBAKKR_WATCH_ADMIN_KEY?.trim();
	return key?.startsWith(ADMIN_PREFIX) && key.length >= ADMIN_KEY_MIN_LENGTH ? key : null;
}

function toHex(bytes: Uint8Array): string {
	let out = "";
	for (const b of bytes) out += b.toString(16).padStart(2, "0");
	return out;
}
