'use strict';

/**
 * 流量面板服务。
 *
 * 端口默认 15551，数据目录默认 /data（Docker 里挂卷）。
 * 面板与采集端点都不做鉴权 —— 只部署在内网，前面不要加公网映射。
 *
 * 路由：
 *   GET  /                        面板
 *   GET  /pull                    采集端点（Prometheus 文本，?format=json 换 JSON）
 *   GET  /pull/:provider          按云厂商过滤：huawei / tencent
 *   GET  /api/state               面板数据
 *   POST /api/accounts            新增账号
 *   PUT  /api/accounts/:id        修改账号
 *   DELETE /api/accounts/:id      删除账号（连带历史）
 *   POST /api/accounts/:id/test   用已保存凭据试跑一次
 *   POST /api/settings            改采集频率 / 阈值
 *   POST /api/collect             手动触发一次采集
 *   GET  /api/history             历史曲线
 *   GET  /api/runs                采集记录
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const { loadKey, createCipher } = require('./crypto');
const { createStore } = require('./store');
const { createCollector } = require('./collector');
const providers = require('./providers');
const prometheus = require('./formats/prometheus');

const PORT = Number(process.env.PORT) || 15551;
const DATA_DIR = process.env.DATA_DIR || '/data';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const key = loadKey(DATA_DIR);
const cipher = createCipher(key);
const store = createStore({ dataDir: DATA_DIR, cipher });
const collector = createCollector({ store, providers });

// ---------------------------------------------------------------- 工具

function sendJson(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function providerList() {
  return Object.values(providers).map((p) => ({
    id: p.id,
    title: p.title,
    ready: p.ready,
    fields: p.fields
  }));
}

function pullJson(providerId) {
  const items = store.latestSnapshots();
  const filtered = providerId ? items.filter((i) => i.provider === providerId) : items;
  const groups = [];

  for (const p of Object.values(providers)) {
    if (providerId && p.id !== providerId) continue;
    const rows = filtered
      .filter((i) => i.provider === p.id)
      .map((i) => ({
        account: i.accountSlug,
        accountName: i.accountName,
        instance: i.instanceName,
        instanceId: i.instanceId,
        region: (i.extra && i.extra.region) || null,
        usage: i.usageType,
        remaining: i.amount,
        total: i.original,
        unit: i.unit,
        usedPct: i.usedPct,
        alert: i.alertLevel,
        cycleEnd: i.cycleEnd,
        expireTime: i.expireTime,
        resourceId: i.resourceId,
        collectedAt: i.collectedAt
      }));
    groups.push({ provider: p.id, title: p.title, count: rows.length, items: rows });
  }

  const lastRun = store.lastRun();
  return {
    generatedAt: new Date().toISOString(),
    lastCollect: lastRun
      ? { at: lastRun.finished_at || lastRun.started_at, ok: Boolean(lastRun.ok), message: lastRun.message }
      : null,
    groups
  };
}

// ---------------------------------------------------------------- 路由处理

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method.toUpperCase();

  if (url.pathname === '/api/state' && method === 'GET') {
    return sendJson(res, 200, {
      accounts: store.listAccounts(),
      snapshots: store.latestSnapshots(),
      settings: store.getSettings(),
      collector: collector.status(),
      lastRun: store.lastRun(),
      providers: providerList(),
      pullPaths: ['/pull', '/pull/huawei', '/pull/tencent']
    });
  }

  if (url.pathname === '/api/accounts' && method === 'POST') {
    const body = await readBody(req);
    const err = validateAccount(body, true) || validateProviderFields(body.provider, body);
    if (err) return sendJson(res, 400, { error: err });
    try {
      const account = store.createAccount(body);
      collector.schedule(store.getSettings().collect_interval_min);
      return sendJson(res, 200, { account });
    } catch (e) {
      return sendJson(res, 400, { error: /UNIQUE/.test(e.message) ? 'slug 已被占用' : e.message });
    }
  }

  if (parts[0] === 'api' && parts[1] === 'accounts' && parts[2]) {
    const id = Number(parts[2]);
    if (!Number.isInteger(id)) return sendJson(res, 400, { error: 'id 不合法' });

    if (method === 'PUT' && parts.length === 3) {
      const body = await readBody(req);
      const current = store.getAccountCredential(id);
      if (!current) return sendJson(res, 404, { error: '账号不存在' });
      /* 可能是局部更新（比如只开关启用），要和库里的现值合并后再校验 */
      const err = validateAccount(body, false) ||
        validateProviderFields(current.provider, { ...current, ...body });
      if (err) return sendJson(res, 400, { error: err });
      const account = store.updateAccount(id, body);
      if (!account) return sendJson(res, 404, { error: '账号不存在' });
      collector.schedule(store.getSettings().collect_interval_min);
      return sendJson(res, 200, { account });
    }

    if (method === 'DELETE' && parts.length === 3) {
      const ok = store.deleteAccount(id);
      return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: '账号不存在' });
    }

    if (method === 'POST' && parts[3] === 'test') {
      const cred = store.getAccountCredential(id);
      if (!cred) return sendJson(res, 404, { error: '账号不存在' });
      const provider = providers[cred.provider];
      if (!provider || !provider.ready) return sendJson(res, 400, { error: '该云厂商尚未接入' });
      try {
        const result = await provider.test(cred);
        return sendJson(res, 200, result);
      } catch (e) {
        return sendJson(res, 200, { ok: false, message: e.message });
      }
    }
  }

  if (url.pathname === '/api/settings' && method === 'POST') {
    const body = await readBody(req);
    const settings = store.saveSettings(body);
    collector.schedule(settings.collect_interval_min);
    return sendJson(res, 200, { settings });
  }

  if (url.pathname === '/api/collect' && method === 'POST') {
    const result = await collector.runOnce('manual');
    return sendJson(res, 200, { result, lastRun: store.lastRun() });
  }

  if (url.pathname === '/api/history' && method === 'GET') {
    const rows = store.history({
      accountId: url.searchParams.get('accountId'),
      resourceId: url.searchParams.get('resourceId'),
      days: Number(url.searchParams.get('days')) || 7
    });
    return sendJson(res, 200, { rows });
  }

  if (url.pathname === '/api/runs' && method === 'GET') {
    return sendJson(res, 200, { runs: store.listRuns(Number(url.searchParams.get('limit')) || 20) });
  }

  return sendJson(res, 404, { error: `没有这个接口: ${method} ${url.pathname}` });
}

function handlePull(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['pull'] 或 ['pull','huawei']
  const providerId = parts[1] || null;

  if (providerId && !providers[providerId]) {
    return sendJson(res, 404, { error: `未知的 provider: ${providerId}` });
  }

  if (url.searchParams.get('format') === 'json') {
    return sendJson(res, 200, pullJson(providerId));
  }

  const items = store.latestSnapshots().filter((i) => !providerId || i.provider === providerId);
  const text = prometheus.renderText({
    items,
    lastRun: store.lastRun(),
    generatedAt: new Date().toISOString()
  });

  res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function serveStatic(req, res, url) {
  const file = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const full = path.join(PUBLIC_DIR, file);

  // 只允许 public 目录内的文件
  if (!full.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('forbidden');
  }

  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('not found');
    }
    const ext = path.extname(full).toLowerCase();
    const type =
      ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'text/javascript; charset=utf-8' : 'text/plain; charset=utf-8';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

function validateAccount(body, isCreate) {
  if (isCreate) {
    if (!providers[body.provider]) return 'provider 不合法';
    if (!body.name || !String(body.name).trim()) return 'name 必填';
    if (!body.slug || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(String(body.slug).trim())) {
      return 'slug 必填，只能是小写字母、数字、短横线，最长 32 位';
    }
    if (!body.ak || !body.sk) return 'AK / SK 必填';
  }
  if (body.slug !== undefined && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(String(body.slug).trim())) {
    return 'slug 只能是小写字母、数字、短横线，最长 32 位';
  }
  return null;
}

/* 厂商自己声明的额外校验（比如腾讯云必须有地域）。厂商没提供就跳过 */
function validateProviderFields(providerId, values) {
  const p = providers[providerId];
  if (!p || typeof p.validate !== 'function') return null;
  return p.validate(values) || null;
}

// ---------------------------------------------------------------- 启动

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname.startsWith('/pull')) return handlePull(req, res, url);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const settings = store.getSettings();
  collector.schedule(settings.collect_interval_min);
  console.log(`流量面板已启动: http://0.0.0.0:${PORT}`);
  console.log(`  采集端点: /pull  |  /pull/huawei  |  /pull?format=json`);
  console.log(`  数据目录: ${DATA_DIR}  采集间隔: ${settings.collect_interval_min} 分钟`);

  // 启动先跑一次，免得面板空白
  collector.runOnce('startup').catch((e) => console.error(`[startup] ${e.message}`));
});

process.on('SIGTERM', () => {
  collector.stop();
  server.close(() => process.exit(0));
});
