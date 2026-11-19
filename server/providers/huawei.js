'use strict';

/**
 * 华为云 provider。
 *
 * 签名与接口封装与 traffic/huaweicloud.js 同源（那份给 CLI 用，这份给面板用，镜像要自包含所以副本）。
 * 改签名逻辑时两边都要改，校验脚本在 .workbuddy-ai/tmp/check-sign-vs-sdk.js。
 *
 * 数据来源两条：
 *   资源包：POST /v3/payments/free-resources/query
 *           -> POST /v2/payments/free-resources/usages/details/query
 *   实例：  GET /v1/resource-manager/domains/{domain_id}/all-resources（配置审计）
 *           -> 取 logical_resource_type=huaweicloudinternal_cbc_freeresource 的 physical_resource_id
 *           -> 同一个使用量接口
 */

const crypto = require('crypto');
const https = require('https');

const BSS_HOST = 'bss.myhuaweicloud.com';
const FLEXUS_L_TYPE = 'hcss.l-instance';
const FLEXUS_TRAFFIC_TYPE = 'huaweicloudinternal_cbc_freeresource';
const FLEXUS_ECS_TYPE = 'huaweicloudinternal_ecs_instance';
const TRAFFIC_MEASURE_TYPES = new Set([3, 14, 40]);

// ---------------------------------------------------------------- 签名

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function hmac256Hex(key, message) {
  return crypto.createHmac('sha256', key).update(message, 'utf8').digest('hex');
}

function rfc3986(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function sdkDate(now = new Date()) {
  return now.toISOString().replace(/[-:]|\.\d{3}/g, '');
}

function canonicalQueryString(query) {
  if (!query) return '';
  return Object.keys(query)
    .filter((k) => query[k] !== undefined && query[k] !== null && query[k] !== '')
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(query[k])}`)
    .join('&');
}

// 规范 URI 必须补尾斜杠，否则网关算出来的签名对不上（APIGW.0301）
function canonicalUriOf(path) {
  const segments = String(path).split('/').map(rfc3986).join('/');
  return segments.endsWith('/') ? segments : segments + '/';
}

function canonicalRequestOf({ method, canonicalUri, query, headers, rawBody }) {
  const keys = Object.keys(headers).sort();
  const canonicalHeaders = keys.map((k) => `${k}:${headers[k]}\n`).join('');
  return [
    method.toUpperCase(),
    canonicalUriOf(canonicalUri),
    canonicalQueryString(query),
    canonicalHeaders,
    keys.join(';'),
    sha256Hex(rawBody || '')
  ].join('\n');
}

function buildSignedHeaders({ method, canonicalUri, query, rawBody, ak, sk, host, date }) {
  const signedHeaderValues = {
    host,
    'content-type': 'application/json',
    'x-sdk-date': sdkDate(date)
  };
  const canonicalRequest = canonicalRequestOf({ method, canonicalUri, query, headers: signedHeaderValues, rawBody });
  const stringToSign = ['SDK-HMAC-SHA256', signedHeaderValues['x-sdk-date'], sha256Hex(canonicalRequest)].join('\n');
  const signature = hmac256Hex(sk, stringToSign);
  const signedHeaders = Object.keys(signedHeaderValues).sort().join(';');

  return {
    host,
    'Content-Type': 'application/json',
    'X-Sdk-Date': signedHeaderValues['x-sdk-date'],
    Authorization: `SDK-HMAC-SHA256 Access=${ak}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  };
}

// ---------------------------------------------------------------- 传输

function send({ method, path, query, rawBody, headers, host, timeout }) {
  return new Promise((resolve, reject) => {
    const qs = canonicalQueryString(query);
    const req = https.request(
      {
        host,
        port: 443,
        method: method.toUpperCase(),
        path: qs ? `${path}?${qs}` : path,
        headers: rawBody ? { ...headers, 'Content-Length': Buffer.byteLength(rawBody) } : headers,
        timeout
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data;
          try {
            data = text ? JSON.parse(text) : {};
          } catch (e) {
            data = { raw: text };
          }
          if (res.statusCode >= 200 && res.statusCode < 300 && !data.error_code) return resolve(data);

          const detail = data.error_code
            ? `${data.error_code} ${data.error_msg || ''}`.trim()
            : String(data.raw || JSON.stringify(data)).slice(0, 300);
          const err = new Error(`HTTP ${res.statusCode} ${detail}`.trim());
          err.statusCode = res.statusCode;
          err.errorCode = data.error_code;
          err.body = data;
          reject(err);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`请求超时（${timeout}ms）`)));
    req.on('error', reject);
    if (rawBody) req.write(rawBody);
    req.end();
  });
}

function createClient({ ak, sk, host = BSS_HOST, timeout = 20000 }) {
  ak = String(ak || '').trim();
  sk = String(sk || '').trim();
  if (!ak || !sk) throw new Error('缺少 AK/SK');

  async function call(method, path, body, opts = {}) {
    const targetHost = opts.host || host;
    const query = opts.query || {};
    const rawBody = body === undefined ? undefined : JSON.stringify(body);
    const headers = buildSignedHeaders({ method, canonicalUri: path, query, rawBody, ak, sk, host: targetHost });
    return send({ method, path, query, rawBody, headers, host: targetHost, timeout });
  }

  return {
    post: (path, body, opts) => call('POST', path, body, opts),
    get: (path, opts) => call('GET', path, undefined, opts)
  };
}

// ---------------------------------------------------------------- 业务接口

async function listFreeResourceInfos(client, { regionCode, status } = {}) {
  const packages = [];
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const payload = { offset, limit: 100 };
    if (regionCode) payload.region_code = regionCode;
    if (status !== undefined && status !== null) payload.status = status;

    const res = await client.post('/v3/payments/free-resources/query', payload);
    const page = res.free_resource_packages || [];
    total = res.total_count === undefined ? page.length : res.total_count;
    packages.push(...page);
    if (!page.length) break;
    offset += page.length;
  }
  return packages;
}

async function listUsagesDetails(client, ids) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  const out = [];
  for (let i = 0; i < unique.length; i += 100) {
    const res = await client.post('/v2/payments/free-resources/usages/details/query', {
      free_resource_ids: unique.slice(i, i + 100)
    });
    out.push(...(res.free_resources || []));
  }
  return out;
}

async function listMeasureUnits(client) {
  try {
    const res = await client.get('/v2/bases/measurements');
    return res.measure_units || [];
  } catch (e) {
    return [];
  }
}

function rmsHostCandidates(region) {
  const list = [];
  const push = (h) => {
    if (h && !list.includes(h)) list.push(h);
  };
  if (region) push(`rms.${region}.myhuaweicloud.com`);
  push('rms.myhuaweicloud.com');
  push('rms.cn-north-4.myhuaweicloud.com');
  return list;
}

function isHostError(err) {
  const code = err && err.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNREFUSED' || code === 'ECONNRESET') return true;
  return Boolean(err && err.statusCode === 404);
}

async function listFlexusInstances(client, { domainId, region }) {
  if (!domainId) throw new Error('未配置账号ID（domain_id）');
  if (!/^[A-Za-z0-9_-]{1,36}$/.test(domainId)) throw new Error('账号ID 格式不正确');

  const path = `/v1/resource-manager/domains/${domainId}/all-resources`;
  const baseQuery = { type: FLEXUS_L_TYPE, limit: 200 };
  if (region) baseQuery.region_id = region;

  let host = null;
  let marker = null;
  const resources = [];

  do {
    const query = marker ? { ...baseQuery, marker } : baseQuery;
    let res;
    if (host) {
      res = await client.get(path, { query, host });
    } else {
      let lastErr = null;
      for (const candidate of rmsHostCandidates(region)) {
        try {
          res = await client.get(path, { query, host: candidate });
          host = candidate;
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (!isHostError(e)) throw e;
        }
      }
      if (lastErr) throw lastErr;
    }
    resources.push(...(res.resources || []));
    marker = res.page_info ? res.page_info.next_marker : null;
  } while (marker);

  return resources;
}

// ---------------------------------------------------------------- provider 接口

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function collect(cred) {
  const client = createClient({ ak: cred.ak, sk: cred.sk });
  const warnings = [];
  const byResource = new Map();

  const measureById = new Map();

  // 1) 独立资源包
  let packages = [];
  try {
    packages = await listFreeResourceInfos(client, { regionCode: cred.region, status: 1 });
  } catch (e) {
    warnings.push(`资源包列表查询失败：${e.message}`);
  }

  const pkgIds = packages.flatMap((p) => (p.free_resources || []).map((r) => r.free_resource_id)).filter(Boolean);

  // 2) Flexus L 实例内的流量包
  let instances = [];
  if (cred.domainId) {
    try {
      instances = await listFlexusInstances(client, { domainId: cred.domainId, region: cred.region });
    } catch (e) {
      warnings.push(`实例查询失败：${e.message}`);
    }
  }

  const flexusIds = [];
  for (const ins of instances) {
    for (const r of (ins.properties && ins.properties.resources) || []) {
      if (r.logical_resource_type === FLEXUS_TRAFFIC_TYPE && r.physical_resource_id) flexusIds.push(r.physical_resource_id);
    }
  }

  const allIds = [...new Set([...pkgIds, ...flexusIds])];
  let details = [];
  if (allIds.length) {
    for (const m of await listMeasureUnits(client)) measureById.set(Number(m.measure_id), m);
    try {
      details = await listUsagesDetails(client, allIds);
    } catch (e) {
      warnings.push(`使用量详情查询失败：${e.message}`);
    }
  }

  const detailById = new Map(details.map((d) => [d.free_resource_id, d]));

  // 资源包侧
  for (const pkg of packages) {
    for (const item of pkg.free_resources || []) {
      const d = detailById.get(item.free_resource_id);
      const measureId = num(d ? d.measure_id : item.measure_id);
      const measure = measureId === null ? null : measureById.get(measureId);
      if (!isTraffic(measure, d ? d.usage_type_name : item.usage_type_name)) continue;

      byResource.set(item.free_resource_id, {
        instanceId: null,
        instanceName: pkg.product_name || null,
        resourceId: item.free_resource_id,
        usageType: (d && d.usage_type_name) || item.usage_type_name || null,
        amount: num(d ? d.amount : item.amount),
        original: num(d ? d.original_amount : item.original_amount),
        unit: measure ? measure.measure_name : null,
        cycleEnd: (d && d.end_time) || null,
        expireTime: pkg.expire_time || null,
        extra: {
          kind: 'package',
          region: pkg.region_code || null,
          productName: pkg.product_name || null,
          orderId: pkg.order_id || null,
          serviceTypeName: pkg.service_type_name || null,
          reuseMode: pkg.quota_reuse_mode === undefined ? null : pkg.quota_reuse_mode
        }
      });
    }
  }

  // 实例侧（覆盖同名资源项，因为实例侧信息更全）
  for (const ins of instances) {
    const props = ins.properties || {};
    const meta = props.metadata || {};
    const resList = Array.isArray(props.resources) ? props.resources : [];
    const ecs = resList.find((r) => r.logical_resource_type === FLEXUS_ECS_TYPE);

    for (const t of resList) {
      if (t.logical_resource_type !== FLEXUS_TRAFFIC_TYPE || !t.physical_resource_id) continue;
      const d = detailById.get(t.physical_resource_id);
      const measureId = num(d ? d.measure_id : null);
      const measure = measureId === null ? null : measureById.get(measureId);

      byResource.set(t.physical_resource_id, {
        instanceId: ins.id || null,
        instanceName: ins.name || null,
        resourceId: t.physical_resource_id,
        usageType: (d && d.usage_type_name) || null,
        amount: d ? num(d.amount) : null,
        original: d ? num(d.original_amount) : null,
        unit: measure ? measure.measure_name : null,
        cycleEnd: (d && d.end_time) || null,
        expireTime: null,
        extra: {
          kind: 'instance',
          region: ins.region_id || null,
          specCode: meta.resource_spec_code || null,
          orderId: meta.order_id || null,
          chargingMode: meta.charging_mode || null,
          ecsId: ecs ? ecs.physical_resource_id : null
        }
      });
    }
  }

  const items = [...byResource.values()];

  if (!items.length && !warnings.length) {
    warnings.push('没有查到流量项：账号下既没有流量类资源包，也没有带流量包的 Flexus L 实例');
  }

  return { items, warnings, scanned: { packages: packages.length, instances: instances.length } };
}

function isTraffic(measure, usageTypeName) {
  if (measure && TRAFFIC_MEASURE_TYPES.has(Number(measure.measure_type))) return true;
  return /流量/.test(String(usageTypeName || ''));
}

async function test(cred) {
  const client = createClient({ ak: cred.ak, sk: cred.sk });
  const packages = await listFreeResourceInfos(client, { regionCode: cred.region, status: 1 });
  let instances = 0;
  if (cred.domainId) {
    instances = (await listFlexusInstances(client, { domainId: cred.domainId, region: cred.region })).length;
  }
  return {
    ok: true,
    message: `连通正常：资源包 ${packages.length} 个${cred.domainId ? `，Flexus L 实例 ${instances} 个` : ''}`
  };
}

module.exports = {
  id: 'huawei',
  title: '华为云',
  ready: true,
  fields: [
    {
      key: 'region',
      label: '区域',
      required: true,
      placeholder: 'cn-southwest-2',
      help: 'Flexus L 只支持 cn-north-4 / cn-east-3 / cn-south-1 / cn-southwest-2'
    },
    {
      key: 'domainId',
      label: '账号ID',
      required: false,
      placeholder: '32 位账号ID',
      help: '填了才会查 Flexus L 实例；不填只查独立资源包'
    }
  ],
  collect,
  test
};
