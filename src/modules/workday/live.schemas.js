import { z } from 'zod';
import { RANGES } from './attendance.domain.js';
import { BREAK_TYPES } from './workday.service.js';
import { day, personId } from './state.schemas.js';

const TEAMS = ['Sales', 'Web', 'Mobile', 'Backend', 'Design', 'QA', 'PMO'];

export const liveQuery = z.object({
  filter: z.enum(['all', 'attention', 'work', 'break', 'delivery', 'sales', 'absent', 'idle']).optional().default('all'),
  feed: z.enum(['all', 'team', 'sales', 'clients']).optional().default('all'),
});

export const pidParams = z.object({ pid: personId });
export const liveBreakBody = z.object({
  type: z.enum(Object.keys(BREAK_TYPES)).optional(),
  note: z.string().max(500).optional().default(''),
});
export const liveTimerBody = z.object({ taskId: z.string().trim().min(1, 'Pick a task.').max(40) });

const rangeFields = {
  range: z.enum(RANGES).optional().default('today'),
  date: day.optional(),
};

export const attendanceQuery = z.object({
  ...rangeFields,
  team: z.enum(TEAMS).optional(),
  q: z.string().max(100).optional().default(''),
  person: personId.optional(),
});

export const timelineQuery = z.object({
  mode: z.enum(['day', 'week']).optional().default('day'),
  day: day.optional(),
  team: z.enum(TEAMS).optional(),
});

export const hoursLogQuery = z.object({ ...rangeFields, person: personId.optional() });
