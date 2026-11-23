import { defineModel, json, REQUIRED } from '../modelKit.js';

/** App settings: one document per key (currency, defaultLeadsView, reminderAlerts …). */
export const Setting = defineModel('settings', {
  value: json(REQUIRED),
}, { pkColumn: 'key' });
