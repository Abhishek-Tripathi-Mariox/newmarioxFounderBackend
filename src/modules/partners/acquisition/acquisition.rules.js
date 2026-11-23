/**
 * Partner acquisition rules shared by the service (server-side subset of mariox-saas
 * src/lib/acquisition.ts). One lead = one person Mariox recruits as a partner; status moves
 * contacted ("Lead") → meeting → followup → converted → onboarding, or rejected.
 * Dates are YYYY-MM-DD strings in the team's local day (the server runs in APP_TZ).
 */

export const ACQ_DEFAULTS = {
  sources: ['LinkedIn', 'Email', 'Job portal', 'Referral', 'Website', 'Event', 'Other'],
  channels: ['WhatsApp', 'Call', 'LinkedIn', 'Email', 'Other'],
  reasons: ['Not interested', 'Commission / terms', 'No time right now', 'Not a fit', 'No response', 'Went with someone else', 'Other'],
  team: ['Ritika', 'Aman', 'Neha', 'Karan'],
  services: ['IT consulting', 'Digital marketing agency', 'Recruitment / staffing', 'Business consulting', 'CA / accounting', 'Real estate', 'Freelance developer', 'Sales consultant', 'Other'],
  countries: ['India', 'UAE', 'USA', 'UK', 'Saudi Arabia', 'Qatar', 'Singapore', 'Canada', 'Australia', 'Germany', 'Other'],
};
export const ACQ_LIST_KEYS = Object.keys(ACQ_DEFAULTS);
export const listsWithDefaults = (s) => Object.fromEntries(ACQ_LIST_KEYS.map((k) => [k, s?.[k]?.length ? s[k] : ACQ_DEFAULTS[k]]));

export const HOME = 'India';
/** Status → board label (used in the duplicate message). */
export const STATUS_LABEL = { contacted: 'Lead', meeting: 'Meeting', followup: 'Follow-up', converted: 'Converted', onboarding: 'Onboarding', rejected: 'Rejected' };
export const MEETING_TYPES = ['Intro call', 'Demo', 'Client presentation', 'Follow-up call'];
export const OPEN = ['contacted', 'meeting', 'followup'];

/** Update-dialog options allowed from each open status. */
export const OPTS = {
  contacted: ['meet', 'later', 'convert', 'reject'],
  meeting: ['done', 'convert', 'move', 'reject'],
  followup: ['again', 'meet', 'convert', 'reject'],
};

/* ------------------------------------------------------------------ dates (YYYY-MM-DD, local day) */
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const localToday = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
export const isDay = (s) => typeof s === 'string' && /^\d{4}-\d\d-\d\d$/.test(s);
/** The browser sends its own "today" so dates match the team's day. */
export const dayOf = (v) => (isDay(v) ? v : localToday());
export const add = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
/** "2026-03-05" → "5 Mar" (+ year when not this year). */
export const fdt = (s) => {
  if (!s || !/^\d{4}-\d\d-\d\d/.test(s)) return s || '—';
  return `${+s.slice(8, 10)} ${MON[+s.slice(5, 7) - 1]}${s.slice(0, 4) !== localToday().slice(0, 4) ? ` ${s.slice(0, 4)}` : ''}`;
};
/** 16:00 → "4:00 PM" */
export const t12 = (s) => {
  if (!s || !/^\d\d?:\d\d/.test(s)) return s || '';
  const [h, m] = s.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
export const isUrl = (s) => /^https?:\/\//i.test(s || '');
/** "linkedin.com/in/x" → "https://linkedin.com/in/x" */
export const withScheme = (u) => (u && !/^https?:\/\//i.test(u) ? `https://${u}` : u);
