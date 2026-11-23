import { z } from 'zod';

/**
 * Input rules of the partner portal (mariox-saas src/lib/validate.ts). Each rule takes the trimmed
 * text and returns an error message or null; the same rules run in the browser
 * (frontend/src/partners/lib/validate.js) and here through the zod helpers at the bottom.
 */

/* ------------------------------------------------------------------ phone numbers with a country code */
// dial: country calling code; len: allowed lengths of the national number; start: allowed first digits.
export const COUNTRIES = [
  { iso: 'IN', name: 'India', dial: '91', len: [10], start: /^[6-9]/ },
  { iso: 'AE', name: 'UAE', dial: '971', len: [9], start: /^[2-9]/ },
  { iso: 'US', name: 'USA', dial: '1', len: [10], start: /^[2-9]/ },
  { iso: 'GB', name: 'UK', dial: '44', len: [10], start: /^[1-9]/ },
  { iso: 'SA', name: 'Saudi Arabia', dial: '966', len: [9], start: /^[1-9]/ },
  { iso: 'QA', name: 'Qatar', dial: '974', len: [8] },
  { iso: 'OM', name: 'Oman', dial: '968', len: [8] },
  { iso: 'KW', name: 'Kuwait', dial: '965', len: [8] },
  { iso: 'BH', name: 'Bahrain', dial: '973', len: [8] },
  { iso: 'SG', name: 'Singapore', dial: '65', len: [8] },
  { iso: 'MY', name: 'Malaysia', dial: '60', len: [9, 10] },
  { iso: 'CA', name: 'Canada', dial: '1', len: [10], start: /^[2-9]/ },
  { iso: 'AU', name: 'Australia', dial: '61', len: [9] },
  { iso: 'NZ', name: 'New Zealand', dial: '64', len: [8, 9, 10] },
  { iso: 'DE', name: 'Germany', dial: '49', len: [10, 11] },
  { iso: 'FR', name: 'France', dial: '33', len: [9] },
  { iso: 'NL', name: 'Netherlands', dial: '31', len: [9] },
  { iso: 'IE', name: 'Ireland', dial: '353', len: [9] },
  { iso: 'ZA', name: 'South Africa', dial: '27', len: [9] },
  { iso: 'KE', name: 'Kenya', dial: '254', len: [9] },
  { iso: 'NG', name: 'Nigeria', dial: '234', len: [10] },
  { iso: 'NP', name: 'Nepal', dial: '977', len: [10] },
  { iso: 'BD', name: 'Bangladesh', dial: '880', len: [10] },
  { iso: 'LK', name: 'Sri Lanka', dial: '94', len: [9] },
  { iso: 'JP', name: 'Japan', dial: '81', len: [10] },
  { iso: 'HK', name: 'Hong Kong', dial: '852', len: [8] },
];
const DEFAULT_COUNTRY = COUNTRIES[0];
const BY_DIAL_LENGTH = [...COUNTRIES].sort((a, b) => b.dial.length - a.dial.length);

/**
 * "+91 98765 43210" → { country, digits }. Numbers without a "+" are read as Indian.
 * The longest matching calling code wins (+971 before +9…).
 */
export function parsePhone(raw) {
  const s = String(raw ?? '').trim();
  const all = s.replace(/\D/g, '');
  if (!s.startsWith('+')) return { country: DEFAULT_COUNTRY, digits: all.replace(/^0+/, '') };
  const hit = BY_DIAL_LENGTH.filter((c) => all.startsWith(c.dial));
  const country = hit[0] ?? DEFAULT_COUNTRY;
  return { country, digits: hit.length ? all.slice(country.dial.length) : all };
}
export const formatPhone = (c, digits) => (digits ? `+${c.dial} ${digits}` : '');

export function phoneError(raw) {
  if (!raw.trim()) return null;
  if (/[^\d\s()+-]/.test(raw)) return 'Use digits only';
  const { country, digits } = parsePhone(raw);
  if (raw.trim().startsWith('+') && !raw.replace(/\D/g, '').startsWith(country.dial)) return 'Unknown country code';
  if (!country.len.includes(digits.length)) return `${country.name} numbers have ${country.len.join(' or ')} digits`;
  if (country.start && !country.start.test(digits)) return `That is not a valid ${country.name} number`;
  return null;
}

/* ------------------------------------------------------------------ text */
const LETTER = /\p{L}/u;
const fail = (ok, msg) => (ok ? null : msg);

export const R = {
  person: (v) => fail(!v || (/^[\p{L}\p{M}][\p{L}\p{M} .,'’-]*$/u.test(v) && v.length >= 2 && v.length <= 80), 'Use letters only (2–80), e.g. Rahul Sharma'),
  company: (v) => fail(!v || (LETTER.test(v) && v.length >= 2 && v.length <= 120), 'Enter a real name with letters (2–120 characters)'),
  title: (v) => fail(!v || (LETTER.test(v) && v.trim().length >= 3 && v.length <= 120), 'Title needs words, not only numbers (3–120 characters)'),
  city: (v) => fail(!v || (/^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u.test(v) && v.length >= 2 && v.length <= 60), 'City should be letters only, e.g. Noida'),
  words: (min = 3, max = 2000) => (v) => fail(!v || (LETTER.test(v) && v.trim().length >= min && v.length <= max), `Write a few words (${min}–${max} characters), not only numbers`),
  tags: (v) => fail(!v || (/^[\p{L}\p{M}0-9 &/.,'’()-]+$/u.test(v) && LETTER.test(v) && v.length <= 200), 'Use words separated by commas, e.g. IT, Healthcare'),
  email: (v) => fail(!v || (v.length <= 254 && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v)), 'Enter a valid email, e.g. name@company.com'),
  url: (v) => fail(!v || (/^https?:\/\/[^\s.]+\.[^\s]{2,}$/i.test(v) && v.length <= 500), 'Enter a full link starting with https://'),
  phone: (v) => phoneError(v),
  pan: (v) => fail(!v || /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v.toUpperCase()), 'PAN looks like ABCDE1234F'),
  gstin: (v) => fail(!v || /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v.toUpperCase()), 'GSTIN is 15 characters, e.g. 09ABCDE1234F1Z5'),
  ifsc: (v) => fail(!v || /^[A-Z]{4}0[A-Z0-9]{6}$/.test(v.toUpperCase()), 'IFSC looks like HDFC0001234'),
  bankAccount: (v) => fail(!v || /^\d{9,18}$/.test(v), 'Account number is 9–18 digits'),
  /** Money in rupees: 0 up to ₹1,000 crore. */
  money: (label = 'Amount', max = 1e10) => (v) => {
    if (v === '' || v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= max ? null : `${label} must be between ₹0 and ₹${(max / 1e7).toLocaleString('en-IN')} crore`;
  },
  /** Calendar dates, YYYY-MM-DD, years 2000–2100. */
  date: (v) => {
    if (!v) return null;
    if (!/^\d{4}-\d\d-\d\d$/.test(v) || Number.isNaN(Date.parse(v))) return 'Pick a valid date';
    const y = +v.slice(0, 4);
    return y < 2000 || y > 2100 ? 'Pick a date between 2000 and 2100' : null;
  },
  time: (v) => fail(!v || /^([01]\d|2[0-3]):[0-5]\d$/.test(v), 'Pick a valid time'),
};

/** Several rules on one field; the first error wins. */
export const all = (...rules) => (v) => {
  for (const r of rules) {
    const e = r?.(v);
    if (e) return e;
  }
  return null;
};

/* ------------------------------------------------------------------ dates and times that must not be in the past (IST) */
const IST = 5.5 * 36e5;
const istNow = () => new Date(Date.now() + IST);
export const istToday = () => istNow().toISOString().slice(0, 10);
const istTime = () => istNow().toISOString().slice(11, 16);

export const notPast = (v, what = 'Date') => R.date(v) ?? (v && v < istToday() ? `${what} can't be in the past` : null);

/** "10:30 AM" → "10:30", "16:00" → "16:00", invalid → ''. */
export function to24(s) {
  const m = /^(\d{1,2}):(\d\d)\s*(AM|PM)?$/i.exec(s.trim());
  if (!m) return '';
  let h = +m[1];
  if (m[3]) h = (h % 12) + (/pm/i.test(m[3]) ? 12 : 0);
  return h > 23 || +m[2] > 59 ? '' : `${String(h).padStart(2, '0')}:${m[2]}`;
}

/** A slot on a day: not a past date, and on today's date (IST) the time must still be ahead. */
export function slotError(date, time, what = 'That time') {
  const d = notPast(date);
  if (d) return d;
  if (!time) return null;
  const t = to24(time);
  if (!t) return 'Pick a valid time';
  if (date === istToday() && t < istTime()) return `${what} has already passed today. Pick a later time.`;
  return null;
}

/* ------------------------------------------------------------------ zod, for the API */
/**
 * zs(rule): optional trimmed text checked by the rule; zs(rule, true): required.
 * @param {(v: string) => string | null} [rule]
 */
export function zs(rule, required = false, max = 2000) {
  const base = z.string().trim().max(max, `Keep it under ${max} characters`);
  const s = required ? base.min(1, 'This field is required') : base;
  const withRule = rule ? s.superRefine((v, ctx) => { const e = rule(v); if (e) ctx.addIssue({ code: 'custom', message: e }); }) : s;
  return required ? withRule : withRule.optional();
}
/** PAN / GSTIN / IFSC are stored upper case. */
export const zUpper = (rule) => zs(rule).transform((v) => (v ? v.toUpperCase() : v));
/** Phone stored normalised as "+91 9876543210". */
export const zPhone = (required = false) =>
  zs(R.phone, required).transform((v) => (v ? formatPhone(parsePhone(v).country, parsePhone(v).digits) : v));
/** Rupee amount (numbers or numeric strings). */
export const zMoney = (label, max) =>
  z.coerce.number().refine((n) => !R.money(label, max)(String(n)), { message: R.money(label, max)('-1') ?? 'Invalid amount' });
