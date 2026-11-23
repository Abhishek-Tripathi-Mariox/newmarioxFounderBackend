import { nextSeq } from '../db/counters.js';

/**
 * Human-readable IDs matching the frontend (MX-1043, PR-112, BUG-1030, F50, T165 …).
 * Each kind draws from its own counter (db/counters.js, same names and start values as the old
 * Postgres sequences), so concurrent inserts never collide.
 */
const SEQ = {
  lead: ['lead_code_seq', (n) => `MX-${n}`],
  followUp: ['follow_up_code_seq', (n) => `F${n}`],
  projectFollowUp: ['project_follow_up_code_seq', (n) => `PF${n}`],
  teamTask: ['team_task_code_seq', (n) => `TT${n}`],
  project: ['project_code_seq', (n) => `PR-${n}`],
  task: ['task_code_seq', (n) => `T${n}`],
  bug: ['bug_code_seq', (n) => `BUG-${n}`],
  log: ['time_log_code_seq', (n) => `L${n}`],
  user: ['user_code_seq', (n) => `u-${n.toString(36)}`],
  member: ['member_code_seq', (n) => `m${n.toString(36)}`],
  role: ['role_code_seq', (n) => `r-${n.toString(36)}`],
};

/**
 * Next id of a kind, e.g. `await nextId('lead')` → 'MX-1043'. Counters are not transactional
 * (like Postgres sequences), so there is no session argument.
 */
export async function nextId(kind) {
  const [seq, fmt] = SEQ[kind];
  return fmt(await nextSeq(seq));
}
