import { ok } from '../../core/http.js';
import * as svc from './live.service.js';

const sendCsv = (res, { rows, name }) => {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${name}"`);
  res.send(svc.toCsv(rows));
};

export const live = async (req, res) => ok(res, await svc.live(req.valid.query));
/** POST /live/:pid/<action> — the action name is fixed per route (see live.routes.js). */
export const action = (name) => async (req, res) => ok(res, await svc.liveAction(req.valid.params.pid, name, req.body || {}));
export const attendance = async (req, res) => ok(res, await svc.attendance(req.valid.query));
export const attendanceCsv = async (req, res) => sendCsv(res, await svc.attendanceCsv(req.valid.query, req.attPids));
export const timeline = async (req, res) => ok(res, await svc.timeline(req.valid.query));
export const hoursLog = async (req, res) => ok(res, await svc.hoursLog(req.valid.query));
export const hoursLogCsv = async (req, res) => sendCsv(res, await svc.hoursLogCsv(req.valid.query, req.attPids));
