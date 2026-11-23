import { ok } from '../../core/http.js';
import * as state from './state.service.js';
import { forbidden, unprocessable } from '../../core/errors.js';
import { can } from '../../middleware/authorize.js';

/**
 * Whose raw workday data the caller may read: null = everyone (signed-in Super Admin, not
 * previewing; narrowed by ?person=). Anyone else by their role's "Attendance & reports" (att)
 * permission: All = everyone; Team = their own pid plus the people who report to them ("Reports
 * to", direct or indirect); none / Own = their own pid. ?person= narrows within that (anyone
 * outside it is forced back to their own pid). Clients and accounts without a person id get 403.
 */
export function scopePids(req, person) {
  if (req.user.isSuper && !req.previewing) return person ? [person] : null;
  if (req.user.role.id === 'r-client' || !req.user.pid) throw forbidden('Clients have no workday');
  // "Attendance & reports" permission: All = everyone, Team = + people who report to them, else own.
  const att = (req.user.role.perms || {}).att || {};
  if (att.v && (att.scope || 'all') === 'all') return person ? [person] : null;
  const mine = att.v && att.scope === 'team' ? [req.user.pid, ...(req.user.reportees || []).map((r) => r.pid)] : [req.user.pid];
  if (person) return mine.includes(person) ? [person] : [req.user.pid];
  return mine;
}

/**
 * Live state: the Super Admin's whole team; a role with "Attendance & reports" Edit gets the people
 * in its scope (to check them in / out from Attendance); everyone else only their own (the header's
 * check-in / break / timer controls).
 */
export const liveState = async (req, res) => {
  const team = req.user.isSuper ? !req.previewing : can(req.user, 'att', 'e');
  ok(res, await state.liveState(scopePids(req, team ? undefined : req.user.pid)));
};

export const attendanceEvents = async (req, res) => {
  const { from, to, person } = req.valid.query;
  const rng = state.dayRange(from, to);
  if (rng[1] <= rng[0]) throw unprocessable('"from" must be on or before "to".');
  if (state.rangeTooLong(rng)) throw unprocessable(`Pick a range of at most ${state.MAX_RANGE_DAYS} days.`);
  ok(res, await state.attendanceEvents(scopePids(req, person), rng));
};

export const shiftReports = async (req, res) => {
  const { from, to, person } = req.valid.query;
  if (from && to && from > to) throw unprocessable('"from" must be on or before "to".');
  ok(res, await state.shiftReports(scopePids(req, person), { from, to }));
};
