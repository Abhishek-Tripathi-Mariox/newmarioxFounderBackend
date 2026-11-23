/**
 * Commission rules (mariox-saas src/lib/metrics.ts). Commission per client payment = amount × rate,
 * where the rate is the project's locked rate, else the partner's current rate, else the fallback.
 */

/** Where the partner's commission on one client payment stands. */
export function commissionState(payment) {
  if (payment.status === 'received') return payment.releasedAt ? 'released' : 'processing';
  return payment.status === 'due' ? 'due' : 'upcoming';
}

/** The rate for one project: its own locked rate, else the partner's (populated owner) rate, else `fallback`. */
export const projectRate = (project, fallback) =>
  project.commissionRate ?? (project.owner && typeof project.owner === 'object' && project.owner.commissionRate != null ? project.owner.commissionRate : fallback);
