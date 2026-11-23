import { Router } from 'express';
import { can, requireSuperAdmin } from '../../middleware/authorize.js';
import { forbidden } from '../../core/errors.js';
import { scopePids } from './state.controller.js';
import { validate } from '../../middleware/validate.js';
import * as s from './live.schemas.js';
import * as ctrl from './live.controller.js';

/**
 * Live now, Attendance, Reports. The company-wide boards (/live, /attendance, /reports/*) are CEO-only
 * (signed-in Super Admin, not previewing). By the "Attendance & reports" (att) permission and its scope:
 *   Edit  = act on someone's day (/live/:pid/* check in / out, break, resume, timer) — people in scope;
 *   View  = the CSV exports, limited to the people in scope.
 * The scoped raw-data reads /live/state, /attendance/events, /shift-reports live in state.routes.js.
 * The guard is per route (not router.use) because this router is mounted at '/'.
 */
const router = Router();
const ceo = requireSuperAdmin;
const pid = validate({ params: s.pidParams });

/** Super Admin, or a role with att Edit acting on someone in its scope; never while previewing. */
function attEdit(req, _res, next) {
  if (req.previewing) throw forbidden('Exit preview to change attendance');
  if (req.user.isSuper) return next();
  if (!can(req.user, 'att', 'e')) throw forbidden(`The ${req.user.role.name} role can't change attendance`);
  const pids = scopePids(req, req.params.pid);
  if (pids && !pids.includes(req.params.pid)) throw forbidden('This person is outside your attendance scope');
  next();
}

/** CSV exports: Super Admin (everyone), else att View limited to the role's scope (req.attPids). */
function attView(req, _res, next) {
  if (req.user.isSuper && !req.previewing) { req.attPids = null; return next(); }
  if (!can(req.user, 'att', 'v')) throw forbidden(`The ${req.user.role.name} role can't view attendance`);
  req.attPids = scopePids(req);
  next();
}

router.get('/live', ceo, validate({ query: s.liveQuery }), ctrl.live);
router.post('/live/:pid/check-in', pid, attEdit, ctrl.action('check-in'));
router.post('/live/:pid/check-out', pid, attEdit, ctrl.action('check-out'));
router.post('/live/:pid/break', pid, attEdit, validate({ body: s.liveBreakBody }), ctrl.action('break'));
router.post('/live/:pid/resume', pid, attEdit, ctrl.action('resume'));
router.post('/live/:pid/timer/start', pid, attEdit, validate({ body: s.liveTimerBody }), ctrl.action('timer/start'));
router.post('/live/:pid/timer/stop', pid, attEdit, ctrl.action('timer/stop'));

router.get('/attendance', ceo, validate({ query: s.attendanceQuery }), ctrl.attendance);
router.get('/attendance/export.csv', attView, validate({ query: s.attendanceQuery }), ctrl.attendanceCsv);

router.get('/reports/timeline', ceo, validate({ query: s.timelineQuery }), ctrl.timeline);
router.get('/reports/hours-log', ceo, validate({ query: s.hoursLogQuery }), ctrl.hoursLog);
router.get('/reports/hours-log/export.csv', attView, validate({ query: s.hoursLogQuery }), ctrl.hoursLogCsv);

export default router;
