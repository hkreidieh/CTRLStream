/**
 * The single redaction pass. The server applies redact() to every tool result before it is
 * returned, and the undo log, snapshot manifests and backups metadata pass through it before
 * they are written. Two layers:
 *
 *  1. Key based: any object property named `key`, `*_key`, `token`, `*_token`, `password`,
 *     `*_password` (and camelCase `fooKey`, `fooToken`, `fooPassword`, `secret`) has its value
 *     replaced by "<set>" or "<empty>".
 *  2. Value based: every string is scrubbed of known secret values (stream keys, websocket
 *     passwords) registered at runtime through SecretRegistry, and of common stream-key shapes.
 */

export const SET = '<set>';
export const EMPTY = '<empty>';
export const REDACTED = '<redacted>';

const SECRET_KEY_PATTERNS: RegExp[] = [
  /^(key|token|password|passwd|secret|streamkey|stream_key|authorization)$/i,
  /[_-](key|token|password|passwd|secret)$/i,
  /[a-z0-9](Key|Token|Password|Secret)$/,
];

/** Keys that look secret by name but are not, and must survive (hotkey binding names etc.). */
const SAFE_KEYS = new Set(['hotkey', 'hotkeys', 'monkey', 'sortKey', 'key_count', 'keyframe_sec', 'keyint_sec']);

export function isSecretKey(name: string): boolean {
  if (SAFE_KEYS.has(name)) return false;
  return SECRET_KEY_PATTERNS.some((re) => re.test(name));
}

/** Holds secret values seen at runtime so they can be scrubbed out of free text (logs, errors). */
export class SecretRegistry {
  private readonly values = new Set<string>();

  add(value: unknown): void {
    if (typeof value !== 'string') return;
    const v = value.trim();
    // Very short values would cause absurd over-redaction (e.g. "1"); real keys are long.
    if (v.length >= 6) this.values.add(v);
  }

  list(): string[] {
    // Longest first so a key that contains another is replaced whole.
    return [...this.values].sort((a, b) => b.length - a.length);
  }

  get size(): number {
    return this.values.size;
  }
}

const STRING_PATTERNS: Array<[RegExp, string]> = [
  // Twitch stream keys.
  [/live_\d{3,}_[A-Za-z0-9]{10,}/g, REDACTED],
  // YouTube style keys: four or five groups of 4 alphanumerics.
  [/\b[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}(?:-[a-z0-9]{4})?\b/g, REDACTED],
  // key=... / token=... / password=... in URLs and ini text.
  [/(\b(?:key|streamkey|stream_key|token|password|server_password|ServerPassword|auth)\s*[=:]\s*)("?)[^\s"&,;]+\2/gi, `$1$2${REDACTED}$2`],
  // "key": "..." inside JSON-in-a-string.
  [/("(?:key|[a-z_]*_key|token|[a-z_]*_token|password|[a-z_]*_password)"\s*:\s*")[^"]*(")/gi, `$1${REDACTED}$2`],
];

export function redactString(s: string, registry?: SecretRegistry): string {
  let out = s;
  if (registry) {
    for (const secret of registry.list()) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
  }
  for (const [re, replacement] of STRING_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

function redactSecretValue(value: unknown): unknown {
  if (value === null || value === undefined || value === '') return EMPTY;
  if (value === SET || value === EMPTY) return value;
  return SET;
}

/** Deep copy of `value` with every secret removed. Never mutates its input. */
export function redact<T>(value: T, registry?: SecretRegistry): T {
  return walk(value, registry, new WeakSet()) as T;
}

function walk(value: unknown, registry: SecretRegistry | undefined, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactString(value, registry);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => walk(v, registry, seen));
  if (value instanceof Date) return value.toISOString();
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSecretKey(k) ? redactSecretValue(v) : walk(v, registry, seen);
  }
  return out;
}
