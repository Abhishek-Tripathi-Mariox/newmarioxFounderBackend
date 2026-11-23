import { defineModel, text, dec, texts, REQUIRED } from '../modelKit.js';

/** Sales leads (MX-1001 …). `company` is the client's company; `company_id` is which of our companies the lead is for. */
export const Lead = defineModel('leads', {
  company: text(REQUIRED),
  contact: text(REQUIRED),
  email: text(''),
  phone: text(''),
  services: texts(),
  source: text(), // → lead_sources.name (renames cascade: masters.service)
  owner_id: text(REQUIRED), // → sales_owners
  first_owner_id: text(), // → sales_owners
  status: text('New'), // → lead_stages.name (renames cascade: masters.service)
  value: dec(2, 0),
  notes: text(''),
  company_id: text('mariox'), // Founders HQ company the lead is for (mariox | hroo | arth | a founder-added one); missing on old rows = 'mariox'
}, {
  indexes: [[{ owner_id: 1 }], [{ status: 1 }], [{ source: 1 }], [{ created_at: 1 }], [{ services: 1 }], [{ company_id: 1 }]],
});
