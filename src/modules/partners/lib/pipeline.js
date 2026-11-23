import { PpSetting } from '../../../db/models/index.js';

/**
 * Admin-configurable sales pipeline (mariox-saas src/lib/pipeline.ts + settings.ts). Open stages are
 * editable; "won" and "lost" are fixed keys that always close a lead.
 */
export const WON = 'won';
export const LOST = 'lost';
const CLOSED = [
  { key: WON, name: 'Won', prob: 100 },
  { key: LOST, name: 'Lost', prob: 0 },
];

export const DEFAULT_PIPELINE = {
  stages: [
    { key: 'lead', name: 'Lead', prob: 10 },
    { key: 'contacted', name: 'Contacted', prob: 20 },
    { key: 'meeting', name: 'Meeting done', prob: 40 },
    { key: 'proposal', name: 'Proposal sent', prob: 60 },
    { key: 'negotiation', name: 'Negotiation', prob: 80 },
  ],
  sources: ['Referral', 'Existing network', 'LinkedIn', 'Event', 'Cold outreach'],
  priorities: [
    { name: 'Hot', tone: 'bad' },
    { name: 'Warm', tone: 'warn' },
    { name: 'Cold', tone: 'info' },
  ],
  lostReasons: ['Not specified', 'Budget', 'Went with competitor', 'No decision', 'Timing'],
};

export const TONES = ['bad', 'warn', 'info', 'good', 'violet', 'fire', 'mute'];

/** Fills any missing part of a stored config with the defaults. */
export function withDefaults(c) {
  return {
    stages: c?.stages?.length ? c.stages : DEFAULT_PIPELINE.stages,
    sources: c?.sources?.length ? c.sources : DEFAULT_PIPELINE.sources,
    priorities: c?.priorities?.length ? c.priorities : DEFAULT_PIPELINE.priorities,
    lostReasons: c?.lostReasons?.length ? c.lostReasons : DEFAULT_PIPELINE.lostReasons,
  };
}

const allStages = (c) => [...c.stages, ...CLOSED];
export const stageKeys = (c) => allStages(c).map((s) => s.key);
export const stageName = (c, key) => allStages(c).find((s) => s.key === key)?.name ?? key;
export const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'stage';

/** Portal settings with pipeline defaults applied: { contacts, announcement, pipeline }. */
export async function getSettings() {
  const doc = await PpSetting.findOne({ key: 'portal' }).lean();
  return {
    contacts: doc?.contacts ?? [],
    announcement: doc?.announcement ?? '',
    pipeline: withDefaults(doc?.pipeline),
  };
}

export const getPipeline = async () => (await getSettings()).pipeline;
