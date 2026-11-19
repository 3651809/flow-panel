'use strict';

/**
 * 腾讯云 provider —— 轻量应用服务器（Lighthouse）。
 *
 * 数据来源两个接口，都在 lighthouse.tencentcloudapi.com：
 *   DescribeInstances                实例列表（名称 / 可用区 / 到期时间 / 状态）
 *   DescribeInstancesTrafficPackages 每个实例的流量包（字节单位，按实例分组）
 *
 * 签名是 TC3-HMAC-SHA256，与华为云的 SDK-HMAC-SHA256 完全不同，不能复用那份代码。
 * 签名逻辑在 ./tc3，单独成文件是为了能被单测直接调用。
 */

const https = require('https');
const { buildAuthorization, DEFAULT_CONTENT_TYPE } = require('./tc3');

const HOST = 'lighthouse.tencentcloudapi.com';
const SERVICE = 'lighthouse';
const VERSION = '2020-03-24';
const GIB = 1024 * 1024 * 1024;
/* 两个接口单次请求的实例数上限都是 100 */
const BATCH = 100;

// ---------------------------------------------------------------- 传输

function send({ action, region, payload, secretId, secretKey, timeout }) {
  const rawBody = JSON.stringify(payload || {});
  const timestamp = Math.floor(Date.now() / 1000);
  const { authorization } = buildAuthorization({
    host: HOST,
    service: SERVICE,
    secretId,
    secretKey,
    action,
    timestamp,
    payload: rawBody
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: HOST,
        port: 443,
        method: 'POST',
        path: '/',
        timeout,
        headers: {
          Authorization: authorization,
          'Content-Type': DEFAULT_CONTENT_TYPE,
          Host: HOST,
          'X-TC-Action': action,
          'X-TC-Version': VERSION,
          'X-TC-Timestamp': String(timestamp),
          'X-TC-Region': region,
          'Content-Length': Buffer.byteLength(rawBody)
        }
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

          /* 腾讯云把业务错误放在 HTTP 200 的 Response.Error 里，只看状态码会漏 */
          const body = data.Response || data;
          if (body && body.Error) {
            const err = new Error(`${body.Error.Code || 'Error'} ${body.Error.Message || ''}`.trim());
            err.errorCode = body.Error.Code;
            err.requestId = body.RequestId;
            return reject(err);
          }
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(body);

          const err = new Error(`HTTP ${res.statusCode} ${String(data.raw || text).slice(0, 300)}`.trim());
          err.statusCode = res.statusCode;
          err.body = data;
          reject(err);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`请求超时（${timeout}ms）`)));
    req.on('error', reject);
    req.write(rawBody);
    req.end();
  });
}

function createClient({ ak, sk, region, timeout = 20000 }) {
  const secretId = String(ak || '').trim();
  const secretKey = String(sk || '').trim();
  const reg = String(region || '').trim();
  if (!secretId || !secretKey) throw new Error('缺少 SecretId / SecretKey');
  if (!reg) throw new Error('腾讯云必须填区域，例如 ap-guangzhou');

  return {
    call: (action, payload) => send({ action, region: reg, payload, secretId, secretKey, timeout })
  };
}

// ---------------------------------------------------------------- 业务接口

async function listInstances(client) {
  const all = [];
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const res = await client.call('DescribeInstances', { Offset: offset, Limit: BATCH });
    const page = res.InstanceSet || [];
    total = res.TotalCount === undefined ? all.length + page.length : Number(res.TotalCount);
    all.push(...page);
    if (page.length < BATCH) break;
    offset += BATCH;
  }
  return all;
}

async function listTrafficPackages(client, instanceIds) {
  const byInstance = new Map();
  for (let i = 0; i < instanceIds.length; i += BATCH) {
    const batch = instanceIds.slice(i, i + BATCH);
    /* 一次最多 100 个实例、返回条数上限也是 100，正常一页就够；
       但 TotalCount 更大时继续翻，免得静默少算流量包 */
    let offset = 0;
    for (let guard = 0; guard < 10; guard += 1) {
      const res = await client.call('DescribeInstancesTrafficPackages', {
        InstanceIds: batch,
        Offset: offset,
        Limit: BATCH
      });
      const page = res.InstanceTrafficPackageSet || [];
      for (const entry of page) {
        byInstance.set(entry.InstanceId, entry.TrafficPackageSet || []);
      }
      const total = res.TotalCount === undefined ? offset + page.length : Number(res.TotalCount);
      offset += page.length;
      /* 以 TotalCount 为准判断是否还有下一页；空页也停，避免 TotalCount 报大时白翻 */
      if (!page.length || offset >= total) break;
    }
  }
  return byInstance;
}

/* 字节转 GB。这几个字段是二进制字节，536870912000 / 1024^3 正好 500 */
function toGb(bytes) {
  if (bytes === null || bytes === undefined) return null;
  const n = Number(bytes);
  if (!Number.isFinite(n)) return null;
  return Math.round((n / GIB) * 100) / 100;
}

// ---------------------------------------------------------------- 对外

async function collect(cred) {
  const client = createClient({ ak: cred.ak, sk: cred.sk, region: cred.region });
  const warnings = [];
  const items = [];

  const instances = await listInstances(client);

  if (!instances.length) {
    warnings.push('该地域下没有轻量应用服务器实例');
    return { items, warnings, scanned: { instances: 0, packages: 0 } };
  }

  let pkgByInstance = new Map();
  try {
    pkgByInstance = await listTrafficPackages(client, instances.map((i) => i.InstanceId).filter(Boolean));
  } catch (e) {
    /* 实例能列出来但流量包查不到（比如策略缺权限）不算整次失败：实例照常展示，标为无数据 */
    warnings.push(`流量包查询失败：${e.message}`);
  }

  let packageCount = 0;

  for (const ins of instances) {
    const pkgs = pkgByInstance.get(ins.InstanceId) || [];
    const base = {
      instanceId: ins.InstanceId || null,
      instanceName: ins.InstanceName || ins.InstanceId || null,
      usageType: '流量包',
      cycleEnd: null,
      expireTime: ins.ExpiredTime || null,
      extra: {
        kind: 'lighthouse',
        region: cred.region,
        zone: ins.Zone || null,
        instanceState: ins.InstanceState || null,
        chargeType: ins.InstanceChargeType || null,
        bandwidthOut: (ins.InternetAccessible && ins.InternetAccessible.InternetMaxBandwidthOut) || null
      }
    };

    if (!pkgs.length) {
      /* 没有流量包的实例也要出现在面板上，否则会让人怀疑是不是漏采了 */
      items.push({
        ...base,
        resourceId: null,
        amount: null,
        original: null,
        unit: null,
        extra: { ...base.extra, reason: 'no-package' }
      });
      continue;
    }

    for (const p of pkgs) {
      packageCount += 1;
      const total = toGb(p.TrafficPackageTotal);
      /* 优先用接口给的剩余量；缺了就用 总量 - 已用 兜底，两者都没有才算无数据 */
      const remaining = p.TrafficPackageRemaining !== null && p.TrafficPackageRemaining !== undefined
        ? toGb(p.TrafficPackageRemaining)
        : (total !== null && p.TrafficUsed !== undefined
          ? toGb(Number(p.TrafficPackageTotal) - Number(p.TrafficUsed))
          : null);

      items.push({
        ...base,
        resourceId: p.TrafficPackageId || null,
        amount: remaining,
        original: total,
        unit: 'GB',
        cycleEnd: p.EndTime || p.Deadline || null,
        extra: {
          ...base.extra,
          status: p.Status || null,
          overflowGb: toGb(p.TrafficOverflow),
          packageStart: p.StartTime || null
        }
      });
    }
  }

  return { items, warnings, scanned: { instances: instances.length, packages: packageCount } };
}

async function test(cred) {
  const client = createClient({ ak: cred.ak, sk: cred.sk, region: cred.region });
  const res = await client.call('DescribeInstances', { Limit: 1 });
  return {
    ok: true,
    message: `连通正常：${cred.region} 下共 ${res.TotalCount || 0} 台轻量实例`
  };
}

/* 保存账号时先拦一道：轻量接口必须带地域，没有它连签名都过不了 */
function validate(cred) {
  if (!String(cred.region || '').trim()) return '区域必填，例如 ap-guangzhou';
  return null;
}

module.exports = {
  id: 'tencent',
  title: '腾讯云',
  ready: true,
  fields: [
    {
      key: 'region',
      label: '区域',
      required: true,
      placeholder: 'ap-guangzhou',
      help: '轻量实例所在地域，如 ap-guangzhou / ap-shanghai / ap-beijing'
    }
  ],
  collect,
  test,
  validate
};
