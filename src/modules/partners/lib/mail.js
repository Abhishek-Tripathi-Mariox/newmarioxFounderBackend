import { mailEnabled, sendMail as deliver } from '../../../core/mailer.js';

/**
 * Partner-portal email (mariox-saas src/lib/mail.ts) on top of the backend's shared SMTP transport
 * (core/mailer.js, SMTP_* settings). Never throws: returns `{ sent, to, error? }` so callers can show
 * whether the email went out.
 */
export async function sendMail({ to, subject, html, text }) {
  if (!mailEnabled()) return { sent: false, to, error: 'Email is not set up (SMTP_USER / SMTP_PASS)' };
  const sent = await deliver({ to, subject, html, text });
  return sent ? { sent: true, to } : { sent: false, to, error: 'The email could not be sent' };
}
