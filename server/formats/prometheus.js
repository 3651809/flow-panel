'use strict';

/**
 * Prometheus 文本格式渲染（text/plain; version=0.0.4）。
 *
 * 单位不硬转字节：华为云返回的是 GB 数值，腾讯云可能是 TB，
 * 强行换算等于给数据加一个没根据的假设，所以数值原样输出，单位放 unit 标签。
 */

const ALERT_VALUE = { ok: 0, warn: 1, crit: 2 };

function escapeLabel(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

function labelsOf(item) {
  const pairs = [
    ['provider', item.provider],
    ['account', item.accountSlug],
    ['instance', item.instanceName || ''],
    ['region', (item.extra && item.extra.region) || ''],
    ['usage', item.usageType || ''],
    ['unit', item.unit || ''],
    ['resource_id', item.resourceId || '']
  ];
  return `{${pairs.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',')}}`;
}

function renderText({ items, lastRun, generatedAt }) {
  const lines = [];
  const help = (name, type, desc) => {
    lines.push(`# HELP ${name} ${desc}`);
    lines.push(`# TYPE ${name} ${type}`);
  };

  help('cloud_traffic_remaining', 'gauge', '剩余流量额度，单位见 unit 标签');
  help('cloud_traffic_total', 'gauge', '套餐/资源包总量，单位见 unit 标签');
  help('cloud_traffic_used_percent', 'gauge', '已用百分比');
  help('cloud_traffic_alert', 'gauge', '阈值状态：0 正常 1 预警 2 严重');
  help('cloud_traffic_cycle_end_seconds', 'gauge', '当前计费周期结束时间（Unix 秒）');
  help('cloud_panel_last_collect_timestamp_seconds', 'gauge', '最近一次采集完成时间（Unix 秒）');
  help('cloud_panel_last_collect_ok', 'gauge', '最近一次采集是否成功：1 成功 0 有失败');
  help('cloud_panel_accounts', 'gauge', '账号数量，按 provider 分组');
  help('cloud_panel_instances', 'gauge', '实例/资源项数量，按 provider 分组');

  for (const it of items) {
    const l = labelsOf(it);
    if (it.amount !== null && it.amount !== undefined) lines.push(`cloud_traffic_remaining${l} ${it.amount}`);
    if (it.original !== null && it.original !== undefined) lines.push(`cloud_traffic_total${l} ${it.original}`);
    if (it.usedPct !== null && it.usedPct !== undefined) lines.push(`cloud_traffic_used_percent${l} ${it.usedPct}`);
    lines.push(`cloud_traffic_alert${l} ${ALERT_VALUE[it.alertLevel] === undefined ? 0 : ALERT_VALUE[it.alertLevel]}`);
    const end = it.cycleEnd ? Math.floor(new Date(it.cycleEnd).getTime() / 1000) : null;
    if (end && Number.isFinite(end)) lines.push(`cloud_traffic_cycle_end_seconds${l} ${end}`);
  }

  if (lastRun) {
    const ts = lastRun.finished_at || lastRun.started_at;
    const sec = ts ? Math.floor(new Date(ts).getTime() / 1000) : null;
    if (sec) lines.push(`cloud_panel_last_collect_timestamp_seconds ${sec}`);
    lines.push(`cloud_panel_last_collect_ok ${lastRun.ok ? 1 : 0}`);
  }

  const byProvider = new Map();
  for (const it of items) {
    const cur = byProvider.get(it.provider) || { accounts: new Set(), count: 0 };
    cur.accounts.add(it.accountSlug);
    cur.count += 1;
    byProvider.set(it.provider, cur);
  }
  for (const [provider, agg] of byProvider) {
    lines.push(`cloud_panel_accounts{provider="${escapeLabel(provider)}"} ${agg.accounts.size}`);
    lines.push(`cloud_panel_instances{provider="${escapeLabel(provider)}"} ${agg.count}`);
  }

  lines.push(`# 采集完成时间: ${generatedAt}`);
  return lines.join('\n') + '\n';
}

module.exports = { renderText, ALERT_VALUE };
