import { PpLead, PpSetting } from '../../../db/models/index.js';
import { PpError } from '../lib/http.js';
import { LOST, WON, getSettings, slug } from '../lib/pipeline.js';

/** Portal settings (mariox-saas src/app/api/settings). */
export { getSettings };

/** Gives new stages a stable key and refuses to drop a stage that still has leads. */
async function preparePipeline(next) {
  const used = new Set([WON, LOST]);
  const stages = next.stages.map((s) => {
    let key = s.key && !used.has(s.key) ? s.key : slug(s.name);
    for (let i = 2; used.has(key); i++) key = `${slug(s.name)}-${i}`;
    used.add(key);
    return { key, name: s.name.trim(), prob: s.prob };
  });

  const current = (await getSettings()).pipeline.stages.map((s) => s.key);
  const removed = current.filter((k) => !used.has(k));
  if (removed.length) {
    const count = await PpLead.countDocuments({ stage: { $in: removed } });
    if (count) throw new PpError(409, `${count} lead(s) are still in a stage you removed. Move them first.`);
  }

  const uniq = (a) => [...new Set(a.map((x) => x.trim()).filter(Boolean))];
  return { stages, sources: uniq(next.sources), priorities: next.priorities, lostReasons: uniq(next.lostReasons) };
}

export async function update({ pipeline, ...rest }) {
  const changes = { ...rest, ...(pipeline ? { pipeline: await preparePipeline(pipeline) } : {}) };
  await PpSetting.findOneAndUpdate({ key: 'portal' }, changes, { upsert: true });
  return getSettings();
}
