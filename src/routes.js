import { Router } from 'express';
import { authenticate, refusePartners } from './middleware/authenticate.js';

import authRoutes from './modules/auth/auth.routes.js';
import { hqRouter } from './modules/hq/hq.routes.js';
import usersRoutes from './modules/users/users.routes.js';
import rolesRoutes from './modules/roles/roles.routes.js';
import auditRoutes from './modules/audit/audit.routes.js';
import peopleRoutes from './modules/people/people.routes.js';
import mastersRoutes from './modules/masters/masters.routes.js';
import workdayStateRoutes from './modules/workday/state.routes.js';
import workdayRoutes from './modules/workday/workday.routes.js';
import liveRoutes from './modules/workday/live.routes.js';
import founderRoutes from './modules/founder/founder.routes.js';
import tasksRoutes from './modules/tasks/tasks.routes.js';
import timesheetsRoutes from './modules/timesheets/timesheets.routes.js';
import bugsRoutes from './modules/bugs/bugs.routes.js';
import changeRequestsRoutes from './modules/change-requests/changeRequests.routes.js';
import portalPublicRoutes from './modules/projects/portal.public.routes.js';
import projectsRoutes from './modules/projects/projects.routes.js';
import milestonesRoutes from './modules/projects/milestones.routes.js';
import projectIntegrationsRoutes from './modules/project-integrations/integrations.routes.js';
import projectFollowupsRoutes from './modules/project-followups/projectFollowups.routes.js';
import documentsRoutes from './modules/documents/documents.routes.js';
import leadsRoutes from './modules/leads/leads.routes.js';
import followupsRoutes from './modules/followups/followups.routes.js';
import teamTasksRoutes from './modules/team-tasks/teamTasks.routes.js';
import dashboardRoutes from './modules/dashboard/dashboard.routes.js';
import { partnersRouter } from './modules/partners/partners.routes.js';

/** /api/v1 — public routes first, then everything behind `authenticate`. */
export function apiRouter() {
  const r = Router();

  // Public
  r.use('/auth', authRoutes); // login / refresh / logout are public; /auth/me authenticates itself
  r.use('/founder', founderRoutes); // server-to-server, guarded by x-founder-key
  r.use('/hq', hqRouter()); // Founders HQ: portal session (mx_refresh cookie) + an HQ seat
  r.use('/public/portal', portalPublicRoutes); // client portal: the token of an ON portal is the credential
  r.use('/pp', partnersRouter()); // Mariox Partners: portal session (mx_refresh cookie), partner or partner admin

  // Authenticated staff (partner accounts only ever use /auth and /pp)
  r.use(authenticate, refusePartners);
  r.use('/users', usersRoutes);
  r.use('/roles', rolesRoutes);
  r.use('/audit-logs', auditRoutes);
  r.use('/', peopleRoutes); // /members, /sales-owners
  r.use('/', mastersRoutes); // /lead-stages, /lead-sources, /services, /settings
  r.use('/', workdayStateRoutes); // raw workday data: /live/state, /attendance/events, /shift-reports
  r.use('/workday', workdayRoutes);
  r.use('/', liveRoutes); // CEO only: /live, /attendance, /reports
  r.use('/tasks', tasksRoutes);
  r.use('/time-logs', timesheetsRoutes);
  r.use('/bugs', bugsRoutes);
  r.use('/change-requests', changeRequestsRoutes);
  r.use('/projects', projectsRoutes);
  r.use('/milestones', milestonesRoutes);
  r.use('/project-integrations', projectIntegrationsRoutes);
  r.use('/project-follow-ups', projectFollowupsRoutes);
  r.use('/documents', documentsRoutes);
  r.use('/leads', leadsRoutes);
  r.use('/follow-ups', followupsRoutes);
  r.use('/team-tasks', teamTasksRoutes);
  r.use('/dashboard', dashboardRoutes);
  return r;
}
