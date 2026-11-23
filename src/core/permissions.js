/**
 * The permission model (roles.perms): one entry per module, `{ v, c, e, d, scope }`.
 * Keep in sync with the frontend role editor (frontend/src/config/constants.js MODULES /
 * MODULE_ACTIONS / NO_SCOPE_MODULES).
 *
 * `acts` = the actions that exist for the module (an action without a real endpoint is never
 * assignable: it is shown as "—" in the editor and kept off when a role is saved). `scope` = the
 * module has a data scope (All / Team / Own).
 *
 * Partner portal admin console (/partners/admin, API /api/v1/pp) — one module per section:
 *   pp_overview   Overview page (its cards only show the sections the role can view)
 *   pp_acq        Acquisition: partner recruitment funnel (C = add / import / sample leads,
 *                 E = update / convert / settings lists, D = delete / clear samples)
 *   pp_partners   Partners: accounts, commission rate, KYC, invites (C = invite, E = edit, D = delete)
 *   pp_leads      Leads of every partner
 *   pp_projects   Projects & payouts
 *   pp_requests   Requests: scope approvals, office visits, tech requests, support tickets
 *                 (no Create: partners raise requests, admins review = Edit, delete = Delete)
 *   pp_kit        Sales kit
 *   pp_settings   Settings: pipeline, announcement, forms (Edit = publish; nothing to create / delete)
 * Partner modules have no data scope: their records belong to partners, not to staff (acquisition
 * leads name an "owner" from a free-text team list, not a user account).
 *
 * Legacy `pp: { v, e }` (one switch for the whole console) is still understood: a role without any
 * `pp_*` key gets every partner module from it (View → View; Edit → Create / Edit / Delete, which
 * is what `pp.e` allowed before). Saving the role writes the new keys and drops `pp`.
 */

export const PP_MODULES = ['pp_overview', 'pp_acq', 'pp_partners', 'pp_leads', 'pp_projects', 'pp_requests', 'pp_kit', 'pp_settings'];

export const MODULES = {
  dash: { acts: 'v', scope: true },
  leads: { acts: 'vced', scope: true },
  fu: { acts: 'vced', scope: true },
  // No project delete: removing milestones, members or change requests is Edit.
  projects: { acts: 'vce', scope: true },
  tasks: { acts: 'vced', scope: true },
  bugs: { acts: 'vced', scope: true },
  // Deleting a time entry is Edit (Team Members fix their own entries).
  ts: { acts: 'vce', scope: true },
  team: { acts: 'v', scope: true },
  users: { acts: 'vced', scope: true },
  // View = see attendance / shift reports (scoped); Edit = check people in / out, breaks and timers.
  att: { acts: 've', scope: true },
  tt: { acts: 'vced', scope: true },
  pp_overview: { acts: 'v', scope: false },
  pp_acq: { acts: 'vced', scope: false },
  pp_partners: { acts: 'vced', scope: false },
  pp_leads: { acts: 'vced', scope: false },
  pp_projects: { acts: 'vced', scope: false },
  pp_requests: { acts: 'ved', scope: false },
  pp_kit: { acts: 'vced', scope: false },
  pp_settings: { acts: 've', scope: false },
};

export const MODS = Object.keys(MODULES);

const EMPTY = { v: false, c: false, e: false, d: false, scope: 'all' };

/** Does module `mod` have action `act` at all? */
export const hasAction = (mod, act) => !!MODULES[mod] && MODULES[mod].acts.includes(act);

/** Legacy `pp: { v, e }` → one cell for a partner module. */
function fromLegacy(mod, pp) {
  const v = !!pp?.v;
  const e = v && !!pp?.e;
  return { v, c: e && hasAction(mod, 'c'), e: e && hasAction(mod, 'e'), d: e && hasAction(mod, 'd'), scope: 'all' };
}

/** Does this perms object still use the single legacy `pp` switch? */
export const isLegacyPp = (perms) => !!perms?.pp && !PP_MODULES.some((m) => perms[m]);

/**
 * Every module present (missing ones = no access), legacy `pp` expanded into the partner modules,
 * unknown keys (incl. `pp`) dropped. Stored values of known modules are kept as they are.
 */
export function normalisePerms(perms) {
  const p = perms || {};
  const legacy = isLegacyPp(p);
  return Object.fromEntries(MODS.map((m) => {
    if (legacy && PP_MODULES.includes(m)) return [m, fromLegacy(m, p.pp)];
    return [m, { ...EMPTY, ...(p[m] || {}) }];
  }));
}

/** Keep only the actions a module has; modules without a data scope are always 'all'. */
export function clampCell(mod, cell) {
  const x = { ...cell };
  for (const a of ['c', 'e', 'd']) if (!hasAction(mod, a)) x[a] = false;
  if (!MODULES[mod].scope) x.scope = 'all';
  return x;
}

/** Can the principal view any partner admin module (= open /partners/admin)? */
export const canPartnerAdmin = (user) => !!user && !user.isPartner && (user.isSuper || PP_MODULES.some((m) => user.role?.perms?.[m]?.v));
