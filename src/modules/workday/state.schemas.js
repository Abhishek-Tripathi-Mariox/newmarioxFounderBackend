import { z } from 'zod';

export const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Invalid date');
export const personId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'Invalid person id');

/** Raw-data endpoints (/attendance/events, /shift-reports): inclusive day bounds + optional person. */
export const eventsQuery = z.object({ from: day.optional(), to: day.optional(), person: personId.optional() });
export const shiftReportsQuery = eventsQuery;
