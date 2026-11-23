import { Router } from 'express';
import acquisitionRoutes from './acquisition/acquisition.routes.js';
import adminUsersRoutes from './admin-users/adminUsers.routes.js';
import authRoutes from './auth/auth.routes.js';
import founderSummaryRoutes from './founder-summary/founder-summary.routes.js';
import leadsRoutes from './leads/leads.routes.js';
import { ppErrorHandler, ppNotFound } from './lib/http.js';
import mainSiteRoutes from './main-site/mainSite.routes.js';
import meRoutes from './me/me.routes.js';
import projectsRoutes from './projects/projects.routes.js';
import { availabilityRouter, requestsRouter } from './requests/requests.routes.js';
import resourcesRoutes from './resources/resources.routes.js';
import settingsRoutes from './settings/settings.routes.js';
import uploadsRoutes from './uploads/uploads.routes.js';

/**
 * /api/v1/pp — the Mariox Partners API (ported from mariox-saas src/app/api). Same sub-paths,
 * payloads, status codes and messages as the Next.js app; its own cookie session (lib/session.js),
 * independent of the internal portal's login. Errors are answered as `{ error }` by ppErrorHandler.
 */
export function partnersRouter() {
  const r = Router();
  r.use('/auth', authRoutes);
  r.use('/me', meRoutes);
  r.use('/settings', settingsRoutes);
  r.use('/leads', leadsRoutes);
  r.use('/projects', projectsRoutes);
  r.use('/requests', requestsRouter);
  r.use('/availability', availabilityRouter);
  r.use('/resources', resourcesRoutes);
  r.use('/uploads', uploadsRoutes);
  r.use('/admin/users', adminUsersRoutes);
  r.use('/admin/acquisition', acquisitionRoutes);
  r.use('/founder', founderSummaryRoutes);
  r.use('/v1', mainSiteRoutes);
  r.use(ppNotFound);
  r.use(ppErrorHandler);
  return r;
}

