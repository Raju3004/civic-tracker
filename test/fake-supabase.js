// In-memory stand-in for the slice of the Supabase client that create-app.js uses.
// Local testing only: nothing here talks to a network.
const crypto = require('crypto');

function likeToRegex(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) {
      out += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (ch === '%') out += '.*';
    else if (ch === '_') out += '.';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + out + '$', 'is');
}

class Query {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.op = 'select';
    this.payload = null;
    this.sort = null;
    this.mode = 'many'; // 'many' | 'one'
  }
  select() { return this; }
  insert(row) { this.op = 'insert'; this.payload = row; return this; }
  update(changes) { this.op = 'update'; this.payload = changes; return this; }
  eq(col, val) { this.filters.push(r => r[col] === val); return this; }
  neq(col, val) { this.filters.push(r => r[col] !== val); return this; }
  not(col, op, val) {
    if (op === 'is' && val === null) this.filters.push(r => r[col] !== null && r[col] !== undefined);
    return this;
  }
  ilike(col, pattern) { this.filters.push(r => likeToRegex(pattern).test(String(r[col] ?? ''))); return this; }
  or(expr) {
    // only the "col.ilike.pattern,col.ilike.pattern" form the app builds
    const tests = expr.split(',').map(part => {
      const m = /^(\w+)\.ilike\.(.*)$/.exec(part);
      return r => likeToRegex(m[2]).test(String(r[m[1]] ?? ''));
    });
    this.filters.push(r => tests.some(t => t(r)));
    return this;
  }
  order(col, { ascending = true } = {}) { this.sort = { col, ascending }; return this; }
  single() { this.mode = 'one'; return this; }
  maybeSingle() { this.mode = 'one'; return this; }
  then(resolve, reject) { return Promise.resolve(this.run()).then(resolve, reject); }

  run() {
    const rows = this.db.tables[this.table];
    if (!rows) return { data: null, error: { message: `relation "${this.table}" does not exist` } };
    const matches = () => rows.filter(r => this.filters.every(f => f(r)));
    let data;
    if (this.op === 'insert') {
      const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...this.payload };
      if (this.table === 'users' && rows.some(u => u.email === row.email)) {
        return { data: null, error: { message: 'duplicate key value violates unique constraint' } };
      }
      rows.push(row);
      data = [row];
    } else if (this.op === 'update') {
      data = matches();
      data.forEach(r => Object.assign(r, this.payload));
    } else {
      data = matches();
      if (this.sort) {
        const { col, ascending } = this.sort;
        data = [...data].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (ascending ? 1 : -1));
      }
    }
    data = data.map(r => ({ ...r }));
    if (this.mode === 'one') return { data: data[0] || null, error: null };
    return { data, error: null };
  }
}

function createFakeSupabase(seed = {}) {
  const db = { tables: { users: [...(seed.users || [])], complaints: [...(seed.complaints || [])] } };
  return { db, from: table => new Query(db, table) };
}

module.exports = { createFakeSupabase };
