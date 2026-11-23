# MongoDB port: rules and status

The Mariox One backend started as a copy of the internal-portal API (Express 5 + knex/Postgres). It now runs on
**MongoDB through mongoose 8**. The HTTP API must stay **byte-for-byte compatible**: the frontend is unchanged, so
every route, status code, response shape and error message stays exactly as it was. The jest suites in `tests/` are
the acceptance criteria.

Everyone porting a module follows the rules below so the codebase stays uniform.

## Port status

| Area | Status | Tests that must pass |
|---|---|---|
| DB layer (`src/db/mongo.js`, `counters.js`, `modelKit.js`, `models/*` for all 36 tables) | done | all |
| Seeds (`src/db/seed/*`, `npm run seed`) | done | `seed.test.js` |
| Test harness (`tests/helpers.js`, `globalSetup.js`, `globalTeardown.js`) | done | all |
| `core/` (`ids`, `audit`, `scope`), `middleware/authenticate`, `authorize`, `errorHandler` | done | all |
| auth (login, refresh, logout, me, change-password, accept-invite, reset-password; self-service forgot password `/auth/forgot*`, model `password_resets` with a TTL index) | done | `auth.test.js`, `email.test.js`, `password-reset.test.js` |
| users, roles, audit-logs, people (`/members`, `/sales-owners`) | done | `users.test.js`, `roles.test.js` |
| masters (`/lead-stages`, `/lead-sources`, `/services`, `/settings`) | done | `masters.test.js` |
| workday raw data (`/live/state`, `/attendance/events`, `/shift-reports`: `workday/state.*`) | done | `reporting-hierarchy.test.js` |
| leads + quotes (`/leads`; `company_id` = the HQ company a lead is for; founders own leads through `founder` sales-owner profiles, `people/founderOwners.js`) | done | `leads.test.js`, `leads-import.test.js`, `leads-company.test.js` |
| follow-ups (`/follow-ups`) | done | `followups.test.js` |
| project follow-ups (`/project-follow-ups`) | done | `project-followups.test.js` |
| team tasks (`/team-tasks`) | done | `team-tasks.test.js` |
| project integrations (`/project-integrations`) | done | `project-integrations.test.js` |
| dashboard (`/dashboard`) | done | `dashboard.test.js` |
| documents (`/documents`) | done | `documents.test.js` |
| projects + milestones (`/projects`, `/milestones`, `clientEmails.js`) | done (CR-driven tests wait for the change-requests port) | `projects.test.js`, `milestones-edit.test.js`, `client-emails.test.js` |
| client portal (`/public/portal`) | done (CR decisions call `changeRequests.service.applyDecision(c, p, act, opts, session)`) | `portal.test.js` |
| change requests (`/change-requests`) | done | `change-requests.test.js` |
| tasks (`/tasks`) | done | `tasks.test.js` |
| bugs (`/bugs`) | done | `bugs.test.js` |
| timesheets (`/time-logs`) | done | `timesheets.test.js` |
| workday (`/workday`; per-person lock: see "Per-person workday lock") | done | `workday.test.js` |
| live / attendance / reports (`/live`, `/attendance`, `/reports`: `workday/live.*`) | done | `live.test.js` |
| founder summary (`/founder`, `founder.repository.js`) | done | `founder.test.js` |
| Founders HQ (`/hq`: auth, users, workspace + prefs, vault, summary, health (HQ → Sales hosts the portal's Leads page on `/leads`); models `hq_users` (seat records), `hq_workspaces`, `hq_workspace_revisions`, `hq_vaults`; one login: portal session + `users.hq_seat`, see docs/SSO.md) | done | `hq-auth`, `hq-users`, `hq-workspace`, `hq-vault`, `hq-summary`, `hq-health` `.test.js` |
| Mariox Partners portal (`/pp`, `modules/partners`, models `pp_*`; plain mongoose schemas copied from mariox-saas, not `defineModel`; one login: portal session + `users.pp_user_id`, see docs/SSO.md) | done | `pp-*.test.js`, `sso.test.js` |
| (cross-module) | — | `integration-endpoints.test.js`, `storage.s3.test.js` |

Unmounted routers are listed in a `TODO(mongo-port)` block in `src/routes.js`. When a module is ported: switch its
imports from `db/knex.js` to the models, mount its router again at the same path, adapt the DB-fixture lines of its
tests (see "Tests"), and update this table.

**When the last module is ported:** delete `src/db/knex.js`, `knexfile.js`, `src/db/migrations/` (the models are
the schema now) and the `knex` / `pg` dependencies; update the README.

## Connection and configuration

- `MONGODB_URI` (app; must name the database, e.g. `mongodb://127.0.0.1:27017/marioxone_dev`),
  `TEST_MONGODB_URI` (tests; server only — the harness picks the database), `DB_POOL_MAX`.
- `src/db/mongo.js`: `connectMongo({ uri?, dbName? })`, `disconnectMongo()`, `ensureIndexes()` (builds every model's
  indexes; `autoIndex` is off), `pingMongo()` (`/health`), `tx(fn)`.
- `server.js` connects and ensures indexes before listening; shutdown disconnects.

## Transactions: `tx(fn)` and `session`

- `tx(async (session) => { … })` runs `fn` inside `session.withTransaction` when the server supports transactions
  (replica set, sharded cluster, Atlas). On a **standalone** server (local dev) it calls `fn(null)` and the app logs
  once at startup that transactions are off: writes then apply one by one.
- Every repository / service helper that used to take a knex `q` / `trx` takes **`session` as its last
  parameter, defaulting to `null`**, and passes it on: `Model.find(…).session(session)`,
  `Model.updateOne(filter, update, { session })`, `Model.insertMany(rows, { session })`,
  `Model.aggregate([...]).session(session)`.
- Because a standalone server cannot roll back, **do every check before the first write** (the existing services
  already validate first), and turn race-prone read-then-write sequences into **conditional updates**
  (`updateOne({ id, status: 'Invited' }, …)` then check `modifiedCount`). This replaces `forUpdate()`,
  `lock table … in share row exclusive mode` and `pg_advisory_xact_lock`. Unique indexes are the last line of
  defence (duplicate key → 409, see "Errors").
- When an error must be returned **after** committing a write (e.g. refresh-token replay revokes all sessions, then
  401), return a marker from `tx` and throw outside it — as `auth.service.refresh` does.

## Per-person workday lock (replaces `pg_advisory_xact_lock`)

Check-in / out, breaks, timers and the end-of-shift report read the person's day, decide, then write — two quick
clicks must not both see "not checked in". `workday.repository.withPersonLock(pid, fn)` serialises them with a
**lease lock on the person's `presence` document** (fields `lock_token`, `locked_until`):

- acquire = one conditional `findOneAndUpdate({ person_id, locked_until: null or expired }, { $set: { lock_token,
  locked_until: now + 30 s } }, { upsert: true })`; an atomic single-document write, so exactly one caller wins. When
  the document is locked (or two callers create it at once) the upsert hits the `_id` unique index (duplicate key):
  the caller waits 20 ms and retries, for up to 10 s (then `409 CONFLICT`). Like the advisory lock, the second click
  waits and then sees the first one's result ("Already checked in." → 409).
- `fn` runs inside `tx()` after the lock is taken; release (`$set` both fields to null, matched on the token) runs in
  `finally`. If `fn` failed and the lock had created the presence document, it is deleted again (a failed action
  leaves no presence trace, as the rolled-back transaction did). The 30 s lease frees the lock if a process dies.
- Why not idempotent conditional writes alone: the rules span several collections (attendance events, the running
  timer, time logs, the report), so no single conditional write can express "not already checked in"; a lock keeps
  the existing service logic unchanged and works the same on a standalone server and on a replica set. Why
  `presence`: it already is the one-document-per-person collection of this module (no new collection).

## Ids (primary keys)

| Postgres PK | MongoDB | Row shape |
|---|---|---|
| text code (`MX-1001`, `u-ceo`, `r-tm`, `mj` …) | `_id` = the code (String) | `id` |
| text natural key that never changes (`settings.key`, `active_timers.person_id`, `presence.person_id`) | `_id` = the value | `key` / `person_id` |
| `bigIncrements` (`audit_logs`, `lead_activities`, `bug_events`, `cr_history`, `project_links`, `attendance_events`, `activity_feed`, `shift_reports`, `project_integrations`, `project_credentials`, `team_task_events`) | `_id` = Number from counter `<table>_id_seq` (starts at 1), assigned automatically on `insertMany` / `save` | `id` (number) |
| `uuid … gen_random_uuid()` (`refresh_tokens`, `documents`) | `_id` = `crypto.randomUUID()` | `id` |
| composite PK (`project_members`, `milestone_members`) or a renameable name (`lead_stages`, `lead_sources`, `services`) | hidden ObjectId `_id` + **unique (compound) index** on the key columns | no id column (as before) |

- The PK column name is a mongoose **alias** of `_id` and `translateAliases` is on, so filters, updates and inserts can
  use it: `User.findOne({ id })`, `Setting.updateOne({ key }, …)`, `Member.insertMany([{ id: 'mj', … }])`.
  **Aggregation pipelines are not translated**: use `_id` inside `aggregate()` (`$match`, `$lookup.foreignField`).
- Reads use **lean** documents converted by `toRow`: `Model.find(…).rows()` / `Model.findOne(…).rows()` return plain
  objects with `_id` renamed to the PK column — exactly the rows knex returned, so the existing mappers keep working.
  `Model.toRow(doc)` converts aggregate results; `Model.insertRows(rows, session)` is `insert(…).returning('*')`.

## Sequences: `counters`

- `src/db/counters.js`: collection `counters`, `{ _id: '<sequence name>', value: <last value handed out> }`.
  `nextSeq(name)`, `nextSeqBlock(name, count)` (atomic `findOneAndUpdate` with `$inc`-style pipeline and upsert),
  `setSeq(name, value)` (= Postgres `setval(name, value)`), `resetSequences()`.
- Start values are the Postgres ones (`SEQUENCE_STARTS`): lead 1001, follow_up 1, project_follow_up 1, team_task 1,
  project 101, task 1, bug 1001, time_log 1, user / member / role 1000; `<table>_id_seq` 1. A counter document is
  created on first use with its start value, so a new database needs no seeding.
- Counters are **not transactional** (no session), like Postgres sequences: an aborted write leaves a gap, but
  concurrent writers never conflict on the counter document.
- `core/ids.js`: **`nextId(kind)`** (was `nextId(trx, kind)`) produces the same codes (`MX-1043`, `u-rs`, `m-…` …).

## Models (`src/db/models/<table>.js`)

One model per former table, **collection name = table name, column names unchanged (snake_case)**, built from all
migrations including later `alterTable` changes. Defined with `defineModel(table, fields, { pk, pkColumn, stamps,
indexes })` from `src/db/modelKit.js`. Import models from `src/db/models/index.js`.

| Postgres | Column helper | Stored as |
|---|---|---|
| `text` | `text()` / `text('')` / `text(REQUIRED)` | String |
| `text` + CHECK `in (…)` | `oneOf(values, default)` | String + enum validator (`null` allowed when nullable) |
| `integer` | `int(def)` | Number (rounded) |
| `numeric(p, s)` | `dec(s, def)` | Number rounded to `s` decimals on write |
| `boolean` | `bool(def)` | Boolean |
| `date` | `day(def)` | `'YYYY-MM-DD'` string (what the pg DATE parser returned) |
| `timestamptz` | `ts(def)`, `ts(Date.now)` for `default now()` | Date |
| `text[]` | `texts()` | [String], default `[]` |
| `jsonb` | `json(def)` | Mixed (store objects/arrays, **never `JSON.stringify`** them) |
| `citext` (users.email) | `text(REQUIRED)` + unique index with `CASE_INSENSITIVE` collation | String as typed |

- The helper argument is the Postgres default: no argument = nullable with default `null`; a value = NOT NULL with
  that default; `REQUIRED` = NOT NULL without default. **NULL is stored explicitly** (never a missing field) so lean
  reads return the same keys as before. `required` means "not null": `''` is valid (as in Postgres).
- `created_at` / `updated_at` are mongoose timestamps (`stamps: 'both' | 'created' | false`); `updated_at` moves on
  every update, like the old trigger.
- Schemas are `strict: 'throw'` (an unknown column is a bug), `minimize: false` (keeps `{}`), no `__v`.
  `runValidators` is global, so CHECK constraints (enum / match / range) also hold for updates.
- UNIQUE → unique index; UNIQUE on a nullable column → **partial** unique index (`$type: 'string'`), because
  Postgres ignores NULLs. Every former index plus the lookup fields used by cascades are indexed.

## Writing queries (knex → mongoose)

| knex / SQL | mongoose |
|---|---|
| `db('t').where({ … }).first()` | `T.findOne({ … }).rows()` |
| `.first('a', 'b')` / `.select(…)` | `.select('a b').rows()` |
| `.pluck('id')` | `T.distinct('_id', filter)` |
| `.count('* as n')` | `T.countDocuments(filter)` (already a number) |
| `whereIn(col, ids)` / `restrictTo(q, col, ids)` | `{ col: { $in: ids } }` / `restrictTo(filter, field, ids)` |
| `whereILike(col, '%q%')` | `{ col: ilike(q) }` (`modelKit.ilike`, regex-escaped) |
| `lower(a) = lower(?)`, citext equality | `.collation(CASE_INSENSITIVE)` |
| `orderBy('name')` on human text | `.sort({ name: 1 }).collation(TEXT_ORDER)` (Postgres en_US-like order) |
| `ORDER BY x` with NULLs | Postgres puts NULLs **last** ascending / **first** descending; MongoDB the opposite — sort on an "is null" key first (see `users.repository.page`) |
| joins | a second query + `Map` (small lists), or `$lookup` in `aggregate()` (paged lists) |
| `insert(rows).returning('*')` | `T.insertRows(rows, session)` |
| `insert(row)` | `T.insertMany([row], { session })` |
| `.onConflict(k).merge()` / `.ignore()` | `updateOne(filter, { $set } / { $setOnInsert }, { upsert: true })` |
| `.increment('position', 1)` | `{ $inc: { position: 1 } }` |
| `? = any(services)` | `{ services: value }` |
| `array_replace(services, a, b)` | `{ $set: { 'services.$[s]': b } }, { arrayFilters: [{ s: a }] }` |
| `jsonb || '{"att": …}'` | `{ 'perms.att': … }` |
| `update(…)` returning a count | `(await T.updateMany(…)).modifiedCount` |
| `now()` | `new Date()`; "today" in `APP_TZ` comes from `modules/workday/time.js` (days compare as strings) |

## Errors

`middleware/errorHandler.js` maps database errors to the same answers the Postgres errors gave:
duplicate key (11000) → `409 CONFLICT "A record with these details already exists"`; validation (enum / match /
range) → `422 CHECK_VIOLATION "A value is out of the allowed range"`; cast errors → `400 BAD_REQUEST "Malformed value
in request"`. There are **no foreign keys**: where the old code relied on an FK violation
(`409 REFERENCE_ERROR "A referenced record does not exist or is still in use"`), check explicitly and throw
`new AppError(409, 'REFERENCE_ERROR', 'A referenced record does not exist or is still in use')`.

## Foreign keys: where each ON DELETE / ON UPDATE lives

Implement the cascade in the service / repository that deletes (or renames) the parent, inside the same `tx`.

| Parent → children | Action | Implemented in |
|---|---|---|
| users → refresh_tokens.user_id, team_tasks.assignee_id (→ team_task_events.task_id) | CASCADE | `users.repository.removeUser` ✔ |
| users → users.reports_to, audit_logs.actor_user_id, lead_activities.actor_user_id, bug_events.actor_user_id, documents.uploaded_by, project_follow_ups.created_by, project_integrations.created_by, project_credentials.updated_by, team_tasks.created_by, team_task_events.user_id | SET NULL | `users.repository.removeUser` ✔ |
| roles → users.role_id | RESTRICT | `roles.service.remove` (refuses while users have it) ✔ |
| lead_stages.name → leads.status, lead_sources.name → leads.source | ON UPDATE CASCADE (delete: restrict) | `masters.service` rename / remove ✔ |
| services.name → leads.services[], projects.services[] | rename in arrays (delete: usage check) | `masters.service` ✔ |
| members / sales_owners → users.member_id / owner_id, milestone_members.member_id … | SET NULL / CASCADE | not needed: members and sales owners are never deleted (deactivated) |
| leads → lead_activities, quotes, follow_ups (CASCADE); activity_feed.lead_id, team_tasks.lead_id (SET NULL) | | `leads.repository.deleteLead` (lead delete and merge; merge first moves the children to the kept lead) ✔ |
| projects → project_members, project_links, milestones (→ milestone_members), change_requests (→ cr_history), tasks (→ active_timers.task_id), bugs (→ bug_events), time_logs, active_timers, project_follow_ups, project_integrations (→ project_credentials) (CASCADE); team_tasks.project_id (SET NULL); documents of the project / its bugs / CRs (removed, files after commit) | | `projects.repository.removeProject` ✔ (no API deletes projects yet) |
| milestones → milestone_members (CASCADE); change_requests.milestone_id, tasks / bugs / time_logs / active_timers.milestone_id (SET NULL) | | `projects.repository.removeMilestone` (used by `projects.service.deleteMilestone`) ✔ |
| change_requests → cr_history (CASCADE); milestones.cr_id, tasks.cr_id (SET NULL) | | `changeRequests.service.remove` ✔ |
| tasks → active_timers.task_id | CASCADE | `tasks.repository.remove` ✔ |
| bugs → bug_events | CASCADE | `bugs.repository.remove` ✔ |
| project_integrations → project_credentials | CASCADE | `integrations.service.remove` ✔ |
| team_tasks → team_task_events | CASCADE | `teamTasks.service.remove` ✔ |
| documents (entity_type, entity_id) | none (polymorphic, never had an FK) | — |
| pp_users → pp_leads, pp_scope/booking/tech/ticket_requests, pp_files (+ stored objects), the partner's portal user (users.pp_user_id, via `users.repository.removeUser`) | CASCADE (refused while pp_projects exist) | `partners/admin-users/adminUsers.service.remove` ✔ |
| pp_resources.file / pp_scope_requests.attachments → pp_files (+ stored object) | delete on replace / remove | `partners/resources`, `partners/requests` services ✔ |

## Core helpers (changed signatures)

- `nextId(kind)` — no transaction argument.
- `audit(req, text, kind, session = null)`.
- `restrictTo(filter, field, ids)` — returns a Mongo filter (`ids` null = unrestricted, `[]` = nothing).
- `peopleScope(user, mod)`, `visibleProjectIds(user)` — unchanged contracts, Mongo inside.
- `reporteesOf(userId, session = null)` (`$graphLookup`, depth ≤ 10, same filtering and order).
- `auth.service.revokeSessions(userId, session = null)` → number of refresh tokens revoked.
- `workday/state.repository.js` has the Mongo reads for attendance events, timers, presence, feed, lead activities
  and shift reports — the workday / live porters should reuse it rather than duplicate them.

## Seeds

`npm run seed` (`src/db/seed/index.js`) connects to `MONGODB_URI`, ensures indexes, then runs `seedBase()`
(`seed/base.js`: roles + permission matrix, lead stages, sources, services, settings — same data as the old
`01_base`) and `createSuperAdmin()` (`seed/superAdmin.js`, from `SUPER_ADMIN_*`, same as the old `02_super_admin`).
Both are idempotent. There were no demo seeds in the Postgres app.

## Tests

- `tests/globalSetup.js` names one throwaway database per jest run, `marioxone_test_<random>`, on
  `TEST_MONGODB_URI`; `tests/helpers.js` connects only to that name (and refuses any other). `resetDb()` empties
  every collection, restarts the counters, seeds the base data and the fixture (same data as before) and sets
  `lead_code_seq` / `project_code_seq` past the fixture codes. `closeDb()` drops the database and disconnects;
  `globalTeardown.js` drops it again in case a file crashed. `emptyTestDb()` is the bare reset (seed tests).
- Run: `TEST_MONGODB_URI=mongodb://127.0.0.1:27017 npm test -- tests/<file>` (`--runInBand` stays). JWT secrets have
  fixed test defaults, so no `.env` is needed for tests.
- Porting a test: change **only** the DB-fixture lines, never an assertion. `db('t').insert(rows)` →
  `T.insertMany(rows)` with identical data (jsonb values as objects, not `JSON.stringify`),
  `db('t').where(f).first()` → `T.findOne(f).rows()`, `db('t').where(f).update(u)` → `T.updateMany(f, u)`,
  `orderBy('id', 'desc')` → `sort({ _id: -1 })`, `db.raw("select setval('x_seq', n)")` → `setSeq('x_seq', n)`.
