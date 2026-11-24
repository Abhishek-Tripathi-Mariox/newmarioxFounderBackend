/**
 * Migration report: per target collection the source count and what happened to each record, plus a
 * list of problems (record ids and reasons only — never secrets).
 */
export class Report {
  constructor({ dryRun = false } = {}) {
    this.dryRun = dryRun;
    /** @type {Map<string, {source:string, target:string, read:number, inserted:number, updated:number, unchanged:number, skipped:number, note?:string}>} */
    this.rows = new Map();
    /** @type {{level:'error'|'warn'|'info', where:string, id?:string, message:string}[]} */
    this.problems = [];
    /** Counters advanced past the migrated ids: { name, from, to } */
    this.counters = [];
  }

  /** The counter row of `source` → `target` (created on first use). */
  row(source, target) {
    const k = `${source} → ${target}`;
    if (!this.rows.has(k)) this.rows.set(k, { source, target, read: 0, inserted: 0, updated: 0, unchanged: 0, skipped: 0 });
    return this.rows.get(k);
  }

  /** Record a skipped source collection / table (ephemeral or not migrated) with its size. */
  skipTable(source, count, note) {
    const r = this.row(source, '(not migrated)');
    r.read += count;
    r.skipped += count;
    r.note = note;
  }

  problem(level, where, id, message) {
    this.problems.push({ level, where, ...(id != null ? { id: String(id) } : {}), message });
  }

  error(where, id, message) { this.problem('error', where, id, message); }
  warn(where, id, message) { this.problem('warn', where, id, message); }
  info(where, id, message) { this.problem('info', where, id, message); }

  get errorCount() { return this.problems.filter((p) => p.level === 'error').length; }

  toJSON() {
    return { dryRun: this.dryRun, collections: [...this.rows.values()], counters: this.counters, problems: this.problems };
  }

  /** Plain-text table for the terminal. */
  format() {
    const head = ['source', 'target', 'read', this.dryRun ? 'new' : 'inserted', this.dryRun ? 'existing' : 'updated', 'unchanged', 'skipped'];
    const body = [...this.rows.values()].map((r) => [r.source, r.target + (r.note ? ` (${r.note})` : ''), r.read, r.inserted, r.updated, r.unchanged, r.skipped].map(String));
    const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
    const line = (cells) => cells.map((c, i) => (i >= 2 ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ');
    const out = [line(head), widths.map((w) => '-'.repeat(w)).join('  '), ...body.map(line)];
    out.push('');
    if (this.counters.length) {
      out.push(`Counters ${this.dryRun ? 'to advance' : 'advanced'}:`);
      for (const c of this.counters) out.push(`  ${c.name}: ${c.from ?? '(start)'} → ${c.to}`);
      out.push('');
    }
    if (!this.problems.length) out.push('No problems.');
    else {
      const counts = ['error', 'warn', 'info'].map((l) => `${this.problems.filter((p) => p.level === l).length} ${l}`).join(', ');
      out.push(`Problems (${counts}):`);
      for (const p of this.problems) out.push(`  [${p.level}] ${p.where}${p.id ? ` ${p.id}` : ''}: ${p.message}`);
    }
    return out.join('\n');
  }
}
