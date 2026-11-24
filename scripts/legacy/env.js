/**
 * Environment of the legacy data migration (docs/MIGRATION.md). Every source connection comes from an
 * env variable; the target is the app's own MONGODB_URI. Nothing here ever prints a password or a
 * full connection string: use `maskUri()` for logs.
 */

/** Source name → env variable(s). */
export const SOURCES = Object.freeze(['portal', 'partners', 'hq']);

const PG_URL = /^postgres(ql)?:\/\/\S+$/;
const MONGO_WITH_DB = /^mongodb(\+srv)?:\/\/[^/\s]+\/([^/?\s]+)(\?\S*)?$/;

/**
 * `scheme://user:***@host/db` — password (and any query string, which may carry secrets) removed.
 * Works for URLs whose password contains '@' (the last '@' before the host separates the credentials).
 */
export function maskUri(uri) {
  if (!uri) return '(not set)';
  const s = String(uri);
  const m = /^([a-z+]+:\/\/)(.*)$/i.exec(s);
  if (!m) return '(invalid url)';
  const [, scheme, rest0] = m;
  const rest = rest0.split('?')[0];
  const at = rest.lastIndexOf('@');
  if (at < 0) return `${scheme}${rest}`;
  const cred = rest.slice(0, at);
  const user = cred.split(':')[0];
  return `${scheme}${user ? `${user}:***` : '***'}@${rest.slice(at + 1)}`;
}

/** Database name in a mongodb:// URI (null when it has none). */
export const mongoDbName = (uri) => MONGO_WITH_DB.exec(String(uri || ''))?.[2] ?? null;

/** Host part (no credentials) of a URI, used to tell databases apart. */
const hostOf = (uri) => {
  const rest = String(uri || '').replace(/^[a-z+]+:\/\//i, '').split('?')[0];
  const at = rest.lastIndexOf('@');
  return rest.slice(at + 1).split('/')[0].toLowerCase();
};

const isBase64Key = (v) => {
  try {
    return Buffer.from(v, 'base64').length === 32;
  } catch {
    return false;
  }
};

/**
 * Validate the variables needed for the selected sources.
 * @param {NodeJS.ProcessEnv} env
 * @param {{ only: string[], targetUri: string }} opts
 * @returns {{ errors: string[], settings: object }}
 */
export function readLegacyEnv(env, { only, targetUri }) {
  const errors = [];
  const val = (k) => (env[k] ?? '').trim();
  const settings = { only, targetUri, portalPgUrl: null, partnersMongoUri: null, hqMongoUri: null, legacyCredentialsKey: null };

  if (!targetUri) errors.push('MONGODB_URI (the Mariox One target database) is not set.');
  else if (!mongoDbName(targetUri)) errors.push('MONGODB_URI must name the database, e.g. mongodb://host:27017/marioxone.');

  if (only.includes('portal')) {
    const url = val('LEGACY_PORTAL_PG_URL');
    if (!url) errors.push('LEGACY_PORTAL_PG_URL is not set (postgres://user:password@host:5432/database of the old internal portal).');
    else if (!PG_URL.test(url)) errors.push('LEGACY_PORTAL_PG_URL must start with postgres:// or postgresql://.');
    else settings.portalPgUrl = url;

    const key = val('LEGACY_PORTAL_CREDENTIALS_KEY');
    if (key) {
      if (!isBase64Key(key)) errors.push('LEGACY_PORTAL_CREDENTIALS_KEY must be 32 bytes, base64 (the old portal\'s CREDENTIALS_KEY).');
      else if (!val('CREDENTIALS_KEY')) errors.push('LEGACY_PORTAL_CREDENTIALS_KEY is set but CREDENTIALS_KEY (the Mariox One key) is empty: credentials can\'t be re-encrypted.');
      else settings.legacyCredentialsKey = Buffer.from(key, 'base64');
    }
  }
  for (const [source, name] of [['partners', 'LEGACY_PARTNERS_MONGO_URI'], ['hq', 'LEGACY_HQ_MONGO_URI']]) {
    if (!only.includes(source)) continue;
    const uri = val(name);
    if (!uri) errors.push(`${name} is not set (mongodb://…/<database> of the old ${source === 'hq' ? 'Founders HQ' : 'partner portal'}).`);
    else if (!mongoDbName(uri)) errors.push(`${name} must name the database, e.g. mongodb://host:27017/${source === 'hq' ? 'founders_hq' : 'mariox'}.`);
    else if (targetUri && hostOf(uri) === hostOf(targetUri) && mongoDbName(uri) === mongoDbName(targetUri)) {
      errors.push(`${name} points at the target database itself (${maskUri(uri)}).`);
    } else settings[source === 'hq' ? 'hqMongoUri' : 'partnersMongoUri'] = uri;
  }
  return { errors, settings };
}

/**
 * Command-line flags: --dry-run, --yes, --only=portal,partners,hq.
 * @returns {{ dryRun: boolean, yes: boolean, only: string[], errors: string[], help: boolean }}
 */
export function parseArgs(argv) {
  const out = { dryRun: false, yes: false, only: [...SOURCES], errors: [], help: false };
  for (const a of argv) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--only=')) {
      const list = a.slice(7).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      const bad = list.filter((s) => !SOURCES.includes(s));
      if (bad.length || !list.length) out.errors.push(`--only takes a comma-separated list of: ${SOURCES.join(', ')}`);
      else out.only = SOURCES.filter((s) => list.includes(s));
    } else out.errors.push(`Unknown argument: ${a}`);
  }
  return out;
}
