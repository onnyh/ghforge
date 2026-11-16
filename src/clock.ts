/**
 * clock.ts — the forge's only source of time.
 *
 * A trial runs twice (live, then replayed) and both runs must leave identical
 * state, so nothing in the forge may read the wall clock. Every timestamp the
 * forge emits derives from MAKEFUN_TRIAL_NOW, which the suite sets to the same
 * value for both runs, advanced by a deterministic per-process tick counter:
 * the Nth timestamp handed out in a run is always base + N seconds, so two
 * runs that receive the same requests produce the same bytes.
 */

const FALLBACK_BASE_MS = Date.UTC(2025, 0, 1, 0, 0, 0);

/** Parse MAKEFUN_TRIAL_NOW as an ISO string or as epoch seconds/milliseconds. */
function parseBaseMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return FALLBACK_BASE_MS;
  const text = raw.trim();
  if (/^-?\d+$/.test(text)) {
    const value = Number(text);
    if (!Number.isSafeInteger(value)) return FALLBACK_BASE_MS;
    // Ten digits is epoch seconds, thirteen is milliseconds; anything in
    // between is treated as seconds when it lands before the year 3000.
    return Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? FALLBACK_BASE_MS : parsed;
}

const baseMs = parseBaseMs(process.env.MAKEFUN_TRIAL_NOW);
let tick = 0;

/** The next deterministic instant, as epoch milliseconds. */
export function nowMs(): number {
  const value = baseMs + tick * 1000;
  tick += 1;
  return value;
}

/** The next deterministic instant, as an ISO 8601 string. */
export function nowIso(): string {
  return new Date(nowMs()).toISOString();
}

/** The next deterministic instant, as epoch seconds (git timestamps). */
export function nowEpochSec(): number {
  return Math.floor(nowMs() / 1000);
}

/** The base instant without consuming a tick (stable identity for a boot). */
export function baseIso(): string {
  return new Date(baseMs).toISOString();
}
