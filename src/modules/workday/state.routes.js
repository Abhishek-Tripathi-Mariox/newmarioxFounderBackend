import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import * as s from './state.schemas.js';
import * as ctrl from './state.controller.js';

/**
 * Raw workday data in the frontend store shapes — any staff; Super Admin (not previewing) sees
 * everyone, everyone else by their "Attendance & reports" permission (scope applied in the controller).
 * Mounted at '/': /live/state, /attendance/events, /shift-reports.
 */
const router = Router();

router.get('/live/state', ctrl.liveState);
router.get('/attendance/events', validate({ query: s.eventsQuery }), ctrl.attendanceEvents);
router.get('/shift-reports', validate({ query: s.shiftReportsQuery }), ctrl.shiftReports);

export default router;
