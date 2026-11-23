import { add } from './acquisition.rules.js';

/**
 * 13 sample leads (codes P-S01…P-S13) so the acquisition page has something to show before the
 * team adds real ones (mariox-saas src/lib/acquisition-server.ts → sampleLeads, unchanged data).
 * @param {string} t today (YYYY-MM-DD)
 */
export function sampleLeads(t) {
  const d = (n) => add(t, n);
  const L = (code, name, company, source, channel, owner, contactedAt, status, x = {}) => ({
    code, name, company, source, channel, owner, contactedAt, status, steps: [{ k: 'contacted', date: contactedAt, note: `Contacted on ${channel}` }], meet: {}, services: [], temp: 'warm', sample: true, ...x,
  });
  const leads = [
    L('P-S01', 'Ananya Mehta', 'BrightPath Consulting', 'LinkedIn', 'LinkedIn', 'Ritika', d(-26), 'converted', { convertedAt: d(-12), phone: '+91 98450 11223', linkedin: 'https://www.linkedin.com/in/ananya-mehta' }),
    L('P-S02', 'Rohan Kapoor', 'Kapoor Digital', 'Job portal', 'Email', 'Aman', d(-20), 'converted', { convertedAt: d(-3), email: 'rohan@kapoordigital.in' }),
    L('P-S03', 'Priya Nair', 'Nair Tech Advisors', 'LinkedIn', 'LinkedIn', 'Ritika', d(-12), 'followup', { next: d(-1), phone: '+91 99200 44110' }),
    L('P-S04', 'James Carter', 'Carter & Co', 'Referral', 'Email', 'Neha', d(-10), 'followup', { next: d(0) }),
    L('P-S05', 'Meera Iyer', 'Iyer Ventures', 'LinkedIn', 'LinkedIn', 'Aman', d(-6), 'meeting', { meet: { date: d(-1), time: '10:00', link: 'https://meet.google.com/mee-raiy-er1' } }),
    L('P-S06', 'Daniel Weber', 'Weber Solutions', 'Job portal', 'Email', 'Ritika', d(-3), 'meeting', { meet: { date: d(0), time: '17:30', link: 'https://zoom.us/j/5512345' } }),
    L('P-S07', 'Sarah Thompson', 'Northside Partners', 'LinkedIn', 'LinkedIn', 'Neha', d(-2), 'meeting', { meet: { date: d(3), time: '16:00', link: 'https://teams.microsoft.com/l/meetup-join/sample' } }),
    L('P-S08', 'Arjun Reddy', 'Reddy Growth Labs', 'Website', 'WhatsApp', 'Aman', d(-1), 'contacted', { next: d(1), phone: '+91 98490 77881' }),
    L('P-S09', 'Kiran Shah', 'Shah Ventures', 'Event', 'Call', 'Neha', d(0), 'contacted', { next: d(0) }),
    L('P-S10', 'Fatima Khan', 'Khan Business Network', 'LinkedIn', 'LinkedIn', 'Ritika', d(-18), 'rejected', { rejectedAt: d(-9), reason: 'Commission / terms' }),
    L('P-S11', 'Liam O\'Brien', 'Harbour Advisory', 'Referral', 'Email', 'Neha', d(-15), 'rejected', { rejectedAt: d(-4), reason: 'No response' }),
    L('P-S12', 'Vikram Joshi', 'Joshi & Associates', 'LinkedIn', 'LinkedIn', 'Aman', d(-9), 'rejected', { rejectedAt: d(-5), reason: 'Not interested' }),
  ];
  const H = {
    'P-S01': [['meeting', -22, 'Meeting arranged'], ['done', -20, 'Runs a 12-person advisory; 3 clients need apps'], ['followup', -15, 'Sent the agreement']],
    'P-S02': [['meeting', -16], ['done', -14, 'Asked for payout examples'], ['followup', -8, 'Reviewing with co-founder']],
    'P-S03': [['meeting', -9], ['done', -8, 'Strong AI network in Mumbai. Wants case studies.']],
    'P-S04': [['meeting', -7], ['done', -6], ['followup', -3, 'Reviewing the agreement with his partner']],
    'P-S05': [['meeting', -5]], 'P-S06': [['meeting', -2]], 'P-S07': [['meeting', -1]],
    'P-S10': [['meeting', -14], ['done', -12, 'Wanted a fixed retainer']],
    'P-S11': [['meeting', -11], ['done', -10], ['followup', -7, 'No reply to 3 messages']],
  };
  const EX = {
    'P-S01': [['IT consulting', 'Business consulting'], 'hot', ['Ritika', 'Karan']], 'P-S02': [['Digital marketing agency'], 'hot', ['Aman']], 'P-S03': [['IT consulting'], 'hot', ['Ritika', 'Neha']],
    'P-S04': [['Business consulting'], 'warm', ['Neha']], 'P-S05': [['Freelance developer'], 'warm', ['Aman', 'Karan']], 'P-S06': [['Recruitment / staffing'], 'hot', ['Ritika', 'Aman']],
    'P-S07': [['Digital marketing agency', 'Sales consultant'], 'warm', ['Neha', 'Karan']], 'P-S08': [['CA / accounting'], 'cold', []], 'P-S09': [['Real estate'], 'warm', []],
    'P-S10': [['Business consulting'], 'cold', ['Ritika']], 'P-S11': [['IT consulting'], 'warm', ['Neha']], 'P-S12': [['Freelance developer'], 'cold', ['Aman']],
  };
  const LOC = {
    'P-S01': ['Bengaluru', 'India'], 'P-S02': ['Delhi', 'India'], 'P-S03': ['Dubai', 'UAE'], 'P-S04': ['New York', 'USA'], 'P-S05': ['Singapore', 'Singapore'], 'P-S06': ['Dubai', 'UAE'],
    'P-S07': ['Toronto', 'Canada'], 'P-S08': ['Hyderabad', 'India'], 'P-S09': ['Riyadh', 'Saudi Arabia'], 'P-S10': ['Abu Dhabi', 'UAE'], 'P-S11': ['London', 'UK'], 'P-S12': ['Pune', 'India'],
  };
  const PH = { 'P-S03': '+971 50 412 7788', 'P-S04': '+1 646 555 0142', 'P-S05': '+65 9123 4567', 'P-S06': '+971 55 290 1144', 'P-S07': '+1 416 555 0199', 'P-S09': '+966 50 123 4567', 'P-S12': '+91 98220 61834', 'P-S02': '+91 98110 22334' };
  const now = new Date();
  now.setMinutes(now.getMinutes() + 95);
  for (const l of leads) {
    const [services, temp, attendees] = EX[l.code];
    l.services = services;
    l.temp = temp;
    l.meet = { duration: 30, ...l.meet, attendees };
    [l.city, l.country] = LOC[l.code];
    if (!l.phone && PH[l.code]) l.phone = PH[l.code];
    if (l.channel === 'LinkedIn') l.channel = 'WhatsApp';
    if (l.code === 'P-S06') l.meet.time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (l.code === 'P-S11') l.steps.push({ k: 'moved', date: d(-12), missed: true, note: 'Did not join' });
    if (l.code === 'P-S04') l.steps.push({ k: 'moved', date: d(-8), missed: true, note: 'Did not join, rebooked' });
    for (const [k, n, note] of H[l.code] || []) l.steps.push({ k, date: d(n), note: note || '' });
    if (l.status === 'converted') l.steps.push({ k: 'converted', date: l.convertedAt, note: 'Signed' });
    if (l.status === 'rejected') l.steps.push({ k: 'rejected', date: l.rejectedAt, reason: l.reason });
  }
  const hm = (m) => { const x = new Date(Date.now() + m * 6e4); return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`; };
  const o = leads.find((l) => l.code === 'P-S01');
  o.status = 'onboarding';
  o.onboardAt = d(-10);
  o.steps.push({ k: 'onboarding', date: d(-10), note: 'Agreement signed, KYC requested' });
  const MT = {
    'P-S05': ['Intro call', [], ''],
    'P-S06': ['Demo', ['Product demo', 'Client PPT'], 'Walk through the partner model and two live client projects'],
    'P-S07': ['Client presentation', ['Client PPT', 'Commission plan'], 'Present to their 3 partners'],
  };
  for (const l of leads) { const m = MT[l.code]; if (m) Object.assign(l.meet, { type: m[0], prep: m[1], agenda: m[2], invited: l.code !== 'P-S05' }); }
  leads.push({
    code: 'P-S13', name: 'Omar Haddad', company: 'Haddad Consulting', source: 'LinkedIn', channel: 'WhatsApp', owner: 'Karan', contactedAt: d(-1), status: 'meeting', sample: true,
    phone: '+971 52 600 3344', email: 'omar@haddadconsulting.ae', linkedin: 'https://www.linkedin.com/in/omar-haddad', city: 'Dubai', country: 'UAE', services: ['Business consulting'], temp: 'hot',
    meet: { date: d(0), time: hm(25), duration: 30, link: 'https://meet.google.com/abc-omar-hdd', type: 'Intro call', attendees: ['Karan', 'Neha'], prep: ['Commission plan'], agenda: 'Understand his client base in the GCC', invited: true },
    steps: [{ k: 'contacted', date: d(-1), note: 'Chatted on LinkedIn, moved to WhatsApp' }, { k: 'meeting', date: d(-1), note: 'Intro call booked' }],
  });
  return leads;
}
