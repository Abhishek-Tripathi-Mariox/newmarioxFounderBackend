const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Next free human-readable code like MX-P-243-7 or TK-2051 (mariox-saas src/lib/codes.ts). Starts after
 * the highest existing number, so seeded or deleted records never collide; callers retry on a
 * duplicate-key error when two writers race (the unique index is the guard).
 * @param {import('mongoose').Model} model
 * @param {string} field   code field
 * @param {string} prefix  e.g. 'TK'
 * @param {number} width   zero padding (0 = none)
 * @param {number} start   first number handed out
 */
export async function nextCode(model, field, prefix, width, start) {
  const re = new RegExp(`^${escapeRe(prefix)}-(\\d+)$`);
  const docs = await model.find({ [field]: re }, { [field]: 1 }).lean();
  const max = docs.reduce((m, d) => Math.max(m, Number(re.exec(d[field])?.[1] ?? 0)), start - 1);
  return `${prefix}-${String(max + 1).padStart(width, '0')}`;
}

/** Run `create(code)`, taking the next code again when a concurrent writer took the same one (up to 5 tries). */
export async function withFreshCode(makeCode, create, codeField) {
  for (let attempt = 0; ; attempt++) {
    const code = await makeCode();
    try {
      return await create(code);
    } catch (e) {
      const dup = e?.code === 11000 && e?.keyPattern?.[codeField];
      if (!dup || attempt >= 4) throw e;
    }
  }
}
