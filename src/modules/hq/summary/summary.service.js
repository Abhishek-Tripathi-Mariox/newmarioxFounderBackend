/**
 * Founder summaries for the HQ summary page. In Mariox One both products live in this backend, so
 * instead of proxying over HTTP (as the standalone HQ did) the summaries are built in-process by the
 * owning modules:
 *   mariox   → modules/founder   `marioxSummary()`  (same data as GET /api/v1/founder/summary)
 *   partners → modules/partners/founder-summary `partnersSummary()` (same data as the partner portal's /api/founder/summary)
 *
 * Kept from the HQ proxy: the `{ data }` envelope, a per-source in-memory cache (60 s), one shared
 * computation for concurrent requests, a timeout, failures never cached, and the error codes
 * 503 NOT_CONFIGURED (the source is not available in this server) / 502 UPSTREAM_ERROR (it failed).
 */
import { logger } from '../../../core/logger.js';
import { hqConfig } from '../hq.config.js';
import { notConfigured, upstreamError } from '../core/errors.js';

/**
 * @typedef {object} SummarySource
 * @property {string} label human name used in error messages
 * @property {() => Promise<((now?: number) => Promise<unknown>) | null | undefined>} load resolves the
 *   in-process summary function (null/undefined or a rejected import = not available)
 */

/** @type {Record<string, SummarySource>} */
export const DEFAULT_SUMMARY_SOURCES = Object.freeze({
  mariox: {
    label: 'Mariox internal portal',
    load: async () => (await import('../../founder/founder.service.js')).marioxSummary,
  },
  partners: {
    label: 'Mariox partners app',
    load: async () => (await import('../../partners/founder-summary/founder-summary.service.js')).partnersSummary,
  },
});

/**
 * @param {object} [options]
 * @param {Record<string, SummarySource>} [options.sources]
 * @param {number} [options.timeoutMs] give up on a summary after this long
 * @param {number} [options.cacheTtlMs] how long a successful answer is reused
 * @param {() => number} [options.now]
 */
export function createSummaryService({
  sources = DEFAULT_SUMMARY_SOURCES,
  timeoutMs = hqConfig.summary.timeoutMs,
  cacheTtlMs = hqConfig.summary.cacheTtlMs,
  now = Date.now,
} = {}) {
  /** @type {Map<string, { value: unknown, expiresAt: number }>} */
  const cache = new Map();
  /** @type {Map<string, Promise<unknown>>} */
  const inFlight = new Map();

  async function resolveBuilder(source, definition) {
    let builder;
    try {
      builder = await definition.load();
    } catch (error) {
      logger.warn({ err: error, source }, 'HQ summary source could not be loaded');
    }
    if (typeof builder !== 'function') throw notConfigured(`The ${definition.label} summary is not set up on this server yet.`);
    return builder;
  }

  async function compute(source, definition) {
    const builder = await resolveBuilder(source, definition);
    let timer;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`summary timed out after ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      return await Promise.race([builder(now()), timeout]);
    } catch (error) {
      logger.error({ err: error, source }, 'HQ summary failed');
      throw upstreamError(`The ${definition.label} is not responding right now. Please try again shortly.`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Summary for one source ("mariox" | "partners").
   * @param {string} source
   */
  async function getSummary(source) {
    const definition = sources[source];
    const cached = cache.get(source);
    if (cached && cached.expiresAt > now()) return cached.value;

    if (!inFlight.has(source)) {
      const request = compute(source, definition)
        .then((value) => {
          cache.set(source, { value, expiresAt: now() + cacheTtlMs });
          return value;
        })
        .finally(() => inFlight.delete(source));
      inFlight.set(source, request);
    }
    return inFlight.get(source);
  }

  return { getSummary };
}

let activeService = createSummaryService();

/** The service the /hq/summary routes use. */
export const summaryService = () => activeService;

/**
 * Swap the service the routes use (tests inject fake sources). Returns the previous one so it can be restored.
 * @param {{ getSummary: (source: string) => Promise<unknown> }} service
 */
export function replaceSummaryService(service) {
  const previous = activeService;
  activeService = service;
  return previous;
}
