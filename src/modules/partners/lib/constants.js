/** Business constants of the partner portal (mariox-saas src/lib/constants.ts, server-side subset). */
export { PP_DEFAULT_COMMISSION_RATE as DEFAULT_COMMISSION_RATE } from '../../../db/models/pp_users.js';

/** Delivery stages of a partner project (index = Project.stage). */
export const PROJECT_STAGES = ['Discovery', 'UI/UX design', 'Development', 'QA & UAT', 'Go-live'];

/** Partner IDs: MX-P-243-1, MX-P-243-2, … */
export const PARTNER_CODE_PREFIX = 'MX-P-243';

/** Where the partner app lives (set-password and sign-in links in emails). */
export const portalUrl = (appUrl) => (process.env.PP_PORTAL_URL || `${appUrl}/partners`).replace(/\/+$/, '');
