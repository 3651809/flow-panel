'use strict';

/**
 * 采集器：按 settings.collect_interval_min 定时跑，结果写 snapshots。
 * 修改频率不需要重启进程，reschedule 一下即可。
 */

function createCollector({ store, providers, log = console }) {
  let timer = null;
  let intervalMin = 30;
  let running = false;
  let nextRunAt = null;
  let lastResult = null;

  function computeLevel(item, cred, settings) {
    if (item.amount === null || !item.original) return 'unknown';
    const remainingPct = (item.amount / item.original) * 100;
    const warn = numOr(cred.warnPct, settings.warn_remaining_pct);
    const crit = numOr(cred.critPct, settings.crit_remaining_pct);
    if (crit !== null && remainingPct <= crit) return 'crit';
    if (warn !== null && remainingPct <= warn) return 'warn';
    return 'ok';
  }

  async function runOnce(reason = 'schedule') {
    if (running) return { skipped: true };
    running = true;

    const runId = store.startRun(reason);
    const settings = store.getSettings();
    const accounts = store.listAccounts().filter((a) => a.enabled);
    const failures = [];
    const notices = [];
    let itemCount = 0;

    try {
      for (const acc of accounts) {
        const cred = store.getAccountCredential(acc.id);
        const provider = providers[cred.provider];

        if (!provider || !provider.ready) {
          store.markAccountResult(acc.id, { ok: false, error: '该云厂商尚未接入' });
          failures.push(`${acc.name}: ${cred.provider} 尚未接入`);
          continue;
        }

        try {
          const result = await provider.collect(cred);
          const collectedAt = new Date().toISOString();
          const items = result.items.map((it) => {
            const level = computeLevel(it, cred, settings);
            const usedPct =
              it.amount !== null && it.original ? Math.round((1 - it.amount / it.original) * 10000) / 100 : null;
            return { ...it, usedPct, alertLevel: level };
          });

          store.insertSnapshots(acc.id, cred.provider, items, collectedAt);
          store.markAccountResult(acc.id, { ok: true });
          itemCount += items.length;
          // 部分链路失败（比如实例接口没权限）不算整次采集失败，但要记下来
          if (result.warnings && result.warnings.length) {
            notices.push(`${acc.name}: ${result.warnings.join('；')}`);
          }
        } catch (e) {
          store.markAccountResult(acc.id, { ok: false, error: e.message });
          failures.push(`${acc.name}: ${e.message}`);
        }
      }

      const message = [...failures, ...notices].join(' | ');
      store.finishRun(runId, { ok: failures.length === 0, itemCount, message });
      store.pruneOld(store.getSettings().keep_days);
      lastResult = { at: new Date().toISOString(), itemCount, failures, notices };
      return { runId, itemCount, failures, notices };
    } finally {
      running = false;
    }
  }

  function schedule(minutes) {
    intervalMin = Math.max(5, Number(minutes) || 30);
    if (timer) clearTimeout(timer);
    nextRunAt = Date.now() + intervalMin * 60000;

    const tick = async () => {
      try {
        await runOnce('schedule');
      } catch (e) {
        log.error(`[collector] 采集失败: ${e.message}`);
      }
      nextRunAt = Date.now() + intervalMin * 60000;
      timer = setTimeout(tick, intervalMin * 60000);
      if (timer.unref) timer.unref();
    };

    timer = setTimeout(tick, intervalMin * 60000);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
    nextRunAt = null;
  }

  function status() {
    return {
      intervalMin,
      running,
      nextRunAt: nextRunAt ? new Date(nextRunAt).toISOString() : null,
      lastResult
    };
  }

  return { runOnce, schedule, stop, status };
}

function numOr(a, b) {
  const n = a !== null && a !== undefined && a !== '' ? Number(a) : Number(b);
  return Number.isFinite(n) ? n : null;
}

module.exports = { createCollector };
