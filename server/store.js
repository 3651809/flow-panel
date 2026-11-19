'use strict';

/**
 * SQLite 存储。用 Node 内置的 node:sqlite（Node >= 22.5），不引第三方依赖，
 * 也就不需要在构建镜像时编译 native 模块。
 */

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_SETTINGS = {
  collect_interval_min: '30',
  warn_remaining_pct: '20',
  crit_remaining_pct: '10',
  keep_days: '90'
};

function maskAk(ak) {
  if (!ak) return '';
  if (ak.length <= 8) return '****';
  return `${ak.slice(0, 4)}****${ak.slice(-4)}`;
}

function createStore({ dataDir, cipher }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'panel.db');
  const db = new DatabaseSync(dbPath);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      region TEXT,
      domain_id TEXT,
      ak_enc TEXT NOT NULL,
      sk_enc TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      warn_pct INTEGER,
      crit_pct INTEGER,
      last_ok_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      instance_id TEXT,
      instance_name TEXT,
      resource_id TEXT,
      usage_type TEXT,
      amount REAL,
      original REAL,
      unit TEXT,
      used_pct REAL,
      alert_level TEXT,
      cycle_end TEXT,
      expire_time TEXT,
      extra TEXT,
      collected_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snap_account ON snapshots(account_id, collected_at);
    CREATE INDEX IF NOT EXISTS idx_snap_resource ON snapshots(resource_id, collected_at);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      ok INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      item_count INTEGER NOT NULL DEFAULT 0,
      message TEXT
    );
  `);

  // ------------------------------------------------------------ settings

  function getSettings() {
    const out = { ...DEFAULT_SETTINGS };
    for (const row of db.prepare('SELECT key, value FROM settings').all()) {
      out[row.key] = row.value;
    }
    return {
      collect_interval_min: Number(out.collect_interval_min) || 30,
      warn_remaining_pct: Number(out.warn_remaining_pct),
      crit_remaining_pct: Number(out.crit_remaining_pct),
      keep_days: Number(out.keep_days) || 90
    };
  }

  function saveSettings(patch) {
    const allowed = Object.keys(DEFAULT_SETTINGS);
    const stmt = db.prepare(
      'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    for (const key of allowed) {
      if (patch[key] !== undefined && patch[key] !== null && patch[key] !== '') {
        stmt.run(key, String(patch[key]));
      }
    }
    return getSettings();
  }

  // ------------------------------------------------------------ accounts

  function safeAccount(row) {
    const ak = cipher.decrypt(row.ak_enc);
    return {
      id: row.id,
      provider: row.provider,
      name: row.name,
      slug: row.slug,
      region: row.region,
      domainId: row.domain_id,
      akMasked: maskAk(ak),
      enabled: Boolean(row.enabled),
      warnPct: row.warn_pct,
      critPct: row.crit_pct,
      lastOkAt: row.last_ok_at,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  function listAccounts() {
    return db.prepare('SELECT * FROM accounts ORDER BY provider, name').all().map(safeAccount);
  }

  function getAccount(id) {
    const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    return row ? safeAccount(row) : null;
  }

  /** 采集内部使用：返回解密后的凭据，绝不外发 */
  function getAccountCredential(id) {
    const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    if (!row) return null;
    return {
      id: row.id,
      provider: row.provider,
      name: row.name,
      slug: row.slug,
      region: row.region,
      domainId: row.domain_id,
      ak: cipher.decrypt(row.ak_enc),
      sk: cipher.decrypt(row.sk_enc),
      enabled: Boolean(row.enabled),
      warnPct: row.warn_pct,
      critPct: row.crit_pct
    };
  }

  function newCredentialFor(id) {
    return getAccountCredential(id);
  }

  function createAccount(input) {
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO accounts(provider, name, slug, region, domain_id, ak_enc, sk_enc, enabled,
                           warn_pct, crit_pct, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      input.provider,
      input.name,
      input.slug,
      input.region || null,
      input.domainId || null,
      cipher.encrypt(input.ak),
      cipher.encrypt(input.sk),
      input.enabled === false ? 0 : 1,
      numOrNull(input.warnPct),
      numOrNull(input.critPct),
      now,
      now
    );
    return getAccount(Number(info.lastInsertRowid));
  }

  function updateAccount(id, input) {
    const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    if (!row) return null;

    const sets = [];
    const args = [];
    const put = (col, val) => {
      sets.push(`${col} = ?`);
      args.push(val);
    };

    if (input.name !== undefined) put('name', input.name);
    if (input.slug !== undefined) put('slug', input.slug);
    if (input.region !== undefined) put('region', input.region || null);
    if (input.domainId !== undefined) put('domain_id', input.domainId || null);
    if (input.enabled !== undefined) put('enabled', input.enabled ? 1 : 0);
    if (input.warnPct !== undefined) put('warn_pct', numOrNull(input.warnPct));
    if (input.critPct !== undefined) put('crit_pct', numOrNull(input.critPct));
    // AK/SK 留空表示不修改
    if (input.ak) put('ak_enc', cipher.encrypt(input.ak));
    if (input.sk) put('sk_enc', cipher.encrypt(input.sk));

    put('updated_at', new Date().toISOString());
    args.push(id);
    db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    return getAccount(id);
  }

  function deleteAccount(id) {
    db.prepare('DELETE FROM snapshots WHERE account_id = ?').run(id);
    const info = db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    return info.changes > 0;
  }

  function markAccountResult(id, { ok, error }) {
    if (ok) {
      db.prepare('UPDATE accounts SET last_ok_at = ?, last_error = NULL WHERE id = ?').run(
        new Date().toISOString(),
        id
      );
    } else {
      db.prepare('UPDATE accounts SET last_error = ? WHERE id = ?').run(String(error || '').slice(0, 500), id);
    }
  }

  // ------------------------------------------------------------ snapshots

  function insertSnapshots(accountId, provider, items, collectedAt) {
    const stmt = db.prepare(`
      INSERT INTO snapshots(account_id, provider, instance_id, instance_name, resource_id, usage_type,
                            amount, original, unit, used_pct, alert_level, cycle_end, expire_time,
                            extra, collected_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const it of items) {
      stmt.run(
        accountId,
        provider,
        it.instanceId || null,
        it.instanceName || null,
        it.resourceId || null,
        it.usageType || null,
        it.amount === undefined ? null : it.amount,
        it.original === undefined ? null : it.original,
        it.unit || null,
        it.usedPct === undefined ? null : it.usedPct,
        it.alertLevel || null,
        it.cycleEnd || null,
        it.expireTime || null,
        it.extra ? JSON.stringify(it.extra) : null,
        collectedAt
      );
    }
  }

  function latestSnapshots() {
    // 每个账号 + 资源项取最新一条
    const rows = db
      .prepare(
        `SELECT s.*, a.name AS account_name, a.slug AS account_slug
           FROM snapshots s
           JOIN accounts a ON a.id = s.account_id
           JOIN (
             SELECT account_id, COALESCE(resource_id, instance_id, '') AS rk, MAX(id) AS max_id
               FROM snapshots
              GROUP BY account_id, rk
           ) m ON m.max_id = s.id
          ORDER BY s.provider, a.name, s.instance_name`
      )
      .all();

    return rows.map((r) => ({
      accountId: r.account_id,
      accountName: r.account_name,
      accountSlug: r.account_slug,
      provider: r.provider,
      instanceId: r.instance_id,
      instanceName: r.instance_name,
      resourceId: r.resource_id,
      usageType: r.usage_type,
      amount: r.amount,
      original: r.original,
      unit: r.unit,
      usedPct: r.used_pct,
      alertLevel: r.alert_level,
      cycleEnd: r.cycle_end,
      expireTime: r.expire_time,
      extra: r.extra ? JSON.parse(r.extra) : null,
      collectedAt: r.collected_at
    }));
  }

  function history({ accountId, resourceId, days = 7 }) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const cond = ['collected_at >= ?'];
    const args = [since];
    if (accountId) {
      cond.push('account_id = ?');
      args.push(Number(accountId));
    }
    if (resourceId) {
      cond.push('resource_id = ?');
      args.push(resourceId);
    }
    return db
      .prepare(
        `SELECT account_id, resource_id, instance_name, amount, original, unit, used_pct, collected_at
           FROM snapshots WHERE ${cond.join(' AND ')} ORDER BY collected_at`
      )
      .all(...args);
  }

  function pruneOld(days) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const info = db.prepare('DELETE FROM snapshots WHERE collected_at < ?').run(since);
    db.prepare('DELETE FROM runs WHERE started_at < ?').run(since);
    return info.changes;
  }

  // ------------------------------------------------------------ runs

  function startRun(reason) {
    const info = db
      .prepare('INSERT INTO runs(started_at, reason) VALUES(?, ?)')
      .run(new Date().toISOString(), reason || 'schedule');
    return Number(info.lastInsertRowid);
  }

  function finishRun(id, { ok, itemCount, message }) {
    db.prepare('UPDATE runs SET finished_at = ?, ok = ?, item_count = ?, message = ? WHERE id = ?').run(
      new Date().toISOString(),
      ok ? 1 : 0,
      itemCount || 0,
      message ? String(message).slice(0, 1000) : null,
      id
    );
  }

  function listRuns(limit = 20) {
    return db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit);
  }

  function lastRun() {
    return db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get() || null;
  }

  return {
    dbPath,
    getSettings,
    saveSettings,
    listAccounts,
    getAccount,
    getAccountCredential,
    newCredentialFor,
    createAccount,
    updateAccount,
    deleteAccount,
    markAccountResult,
    insertSnapshots,
    latestSnapshots,
    history,
    pruneOld,
    startRun,
    finishRun,
    listRuns,
    lastRun
  };
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = { createStore, maskAk };
