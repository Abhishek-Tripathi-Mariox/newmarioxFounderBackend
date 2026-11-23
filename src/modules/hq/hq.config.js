/**
 * Founders HQ settings. Sign-in is the one Mariox One login (docs/SSO.md): the HQ has no session or
 * password settings of its own any more.
 */
export const hqConfig = Object.freeze({
  summary: Object.freeze({ timeoutMs: 8000, cacheTtlMs: 60_000 }),
});
