/* T+1 次日开盘回测：只使用 T 日及以前的日K线，避免未来数据泄漏。 */
const BACKTEST_DEFAULT_LOOKBACK = 120;

function btNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function btPct(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : "";
}

function btThresholds() {
  return {
    minPct: btNumber(document.querySelector("#btPctMin").value),
    maxPct: btNumber(document.querySelector("#btPctMax").value),
    requireMa: checked("btMaBullish"),
    requireNearHigh: checked("btNearHigh"),
    nearHigh: Math.max(0.01, Math.min(1, btNumber(document.querySelector("#btNearHighPct").value) / 100)),
    requireLimitUp: checked("btLimitUp"),
    limitUpDays: Math.max(1, btNumber(document.querySelector("#btLimitUpDays").value) || 20),
    minSamples: Math.max(1, btNumber(document.querySelector("#btMinSamples").value) || 1)
  };
}

function btMatchDay(history, index, options, code, name) {
  const rows = history.slice(0, index + 1);
  const day = rows[rows.length - 1];
  if (!day || day.pct < options.minPct || day.pct > options.maxPct) return false;
  if (options.requireMa && !isMaBullish(rows)) return false;
  if (options.requireNearHigh && !near20dHigh(rows, options.nearHigh)) return false;
  if (options.requireLimitUp && !hasLimitUpGene(code, name, rows, options.limitUpDays)) return false;
  return true;
}

function btAnalyzeHistory(history, code, name, options) {
  const samples = [];
  const start = Math.max(62, 20);
  for (let i = start; i < history.length - 1; i += 1) {
    if (!btMatchDay(history, i, options, code, name)) continue;
    const day = history[i];
    const next = history[i + 1];
    if (!day.close || !next.open) continue;
    const openPct = (next.open / day.close - 1) * 100;
    const highPct = (next.high / day.close - 1) * 100;
    const closePct = (next.close / day.close - 1) * 100;
    samples.push({
      日期: day.date,
      次日: next.date,
      当日涨幅: btPct(day.pct),
      次日开盘涨跌: btPct(openPct),
      次日最高涨跌: btPct(highPct),
      次日收盘涨跌: btPct(closePct)
    });
  }
  return samples;
}

function btSummary(samples) {
  if (!samples.length) return null;
  const open = samples.map((x) => btNumber(x.次日开盘涨跌));
  const high = samples.map((x) => btNumber(x.次日最高涨跌));
  const close = samples.map((x) => btNumber(x.次日收盘涨跌));
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const rate = (xs, threshold) => xs.filter((x) => x >= threshold).length / xs.length * 100;
  return {
    样本数: samples.length,
    次日高开率: `${btPct(rate(open, 0))}%`,
    "高开≥1%": `${btPct(rate(open, 1))}%`,
    "高开≥2%": `${btPct(rate(open, 2))}%`,
    平均开盘涨跌: `${btPct(avg(open))}%`,
    平均最高涨跌: `${btPct(avg(high))}%`,
    平均收盘涨跌: `${btPct(avg(close))}%`
  };
}

function btRenderSummary(items, samples) {
  const box = document.querySelector("#backtestSummary");
  if (!items.length) {
    box.innerHTML = "暂无满足条件的历史样本。";
    return;
  }
  const columns = Object.keys(items[0]);
  const head = columns.map((x) => `<th>${escapeHtml(x)}</th>`).join("");
  const body = items.map((row) => `<tr>${columns.map((x) => `<td>${escapeHtml(row[x])}</td>`).join("")}</tr>`).join("");
  const latest = samples.slice(-20).reverse();
  const latestHtml = latest.length
    ? `<div class="hint">最近历史样本（最多20条）</div><div class="results-scroll"><table><thead><tr><th>代码</th><th>名称</th><th>触发日</th><th>次日</th><th>当日涨幅</th><th>次日开盘</th><th>次日最高</th><th>次日收盘</th></tr></thead><tbody>${latest.map((x) => `<tr><td>${escapeHtml(x.代码)}</td><td>${escapeHtml(x.名称)}</td><td>${escapeHtml(x.日期)}</td><td>${escapeHtml(x.次日)}</td><td>${escapeHtml(x.当日涨幅)}%</td><td>${escapeHtml(x.次日开盘涨跌)}%</td><td>${escapeHtml(x.次日最高涨跌)}%</td><td>${escapeHtml(x.次日收盘涨跌)}%</td></tr>`).join("")}</tbody></table></div>`
    : "";
  box.innerHTML = `<div class="results-scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${latestHtml}`;
}

function btStop(tokenValue) {
  if (!tokenValue) return;
  tokenValue.stopped = true;
  const ids = [...(tokenValue.ids || [])];
  ids.forEach((id) => {
    // 先把 JS 侧 Promise 结束掉，再通知 Android 取消网络 Call。
    // 这样即使 cancel 与 MarketBridge.put() 存在毫秒级竞态，也不会把回测卡死。
    const request = state.pending?.get(id);
    if (request) {
      state.pending.delete(id);
      request.token?.ids.delete(id);
      request.reject(new Error("分析已停止"));
    }
    if (window.MarketAPI) window.MarketAPI.cancel(id);
  });
  tokenValue.ids.clear();
}

async function runT1Backtest() {
  const button = document.querySelector("#backtestButton");
  if (window.__backtestToken) {
    btStop(window.__backtestToken);
    setStatus("正在停止 T+1 回测...");
    logMessage("T+1 回测：已发出停止请求。");
    return;
  }
  const tokenValue = token();
  window.__backtestToken = tokenValue;
  button.textContent = "停止回测";
  setStatus("正在进行 T+1 历史回测...");
  clearLog();
  logMessage("===== 开始 T+1 历史回测 =====");
  logMessage("规则：只使用触发日及以前的历史日K线；次日数据仅用于统计结果。");
  const options = btThresholds();
  const limit = Math.max(1, btNumber(document.querySelector("#btStockLimit").value) || 20);
  try {
    let targets = [];
    const codeText = document.querySelector("#btCodes").value.trim();
    if (codeText) {
      targets = codeText.split(/[ ,，\n]+/).filter(Boolean).map((code) => ({
        code: code.padStart(6, "0"), name: ""
      }));
      logMessage(`已指定 ${targets.length} 只股票：${targets.map((x) => x.code).join("、")}`);
    } else if (state.screenRows.length) {
      targets = state.screenRows.slice(0, limit).map((row) => ({ code: row.代码, name: row.名称 }));
      logMessage(`使用当前选股结果前 ${targets.length} 只作为历史样本池。`);
    } else {
      logMessage("未填写股票代码，也没有当前选股结果；先拉取活跃股票作为历史样本池...");
      const spot = await fetchSpot(tokenValue);
      check(tokenValue);
      targets = spot.sort((a, b) => b.amount - a.amount).slice(0, limit).map((row) => ({ code: row.code, name: row.name }));
      logMessage(`活跃股票样本池准备完成：${targets.length} 只。`);
    }
    if (!targets.length) throw new Error("没有可回测的股票");
    logMessage(`T+1 回测股票 ${targets.length} 只；每只读取最多 ${BACKTEST_DEFAULT_LOOKBACK} 根日K线。`);
    const allSamples = [];
    const summaries = [];
    let finished = 0;
    await mapLimit(targets, 4, async (target) => {
      check(tokenValue);
      logMessage(`回测 ${finished + 1}/${targets.length}：${target.code}${target.name ? ` ${target.name}` : ""}，正在读取历史K线...`);
      const history = await fetchKline(target.code, tokenValue);
      check(tokenValue);
      logMessage(`   ${target.code}：取得 ${history.length} 个交易日，正在计算历史触发样本...`);
      const samples = btAnalyzeHistory(history, target.code, target.name, options);
      samples.forEach((x) => allSamples.push({ ...x, 代码: target.code, 名称: target.name }));
      finished += 1;
      logMessage(`   ${target.code}：命中 ${samples.length} 个历史触发样本；进度 ${finished}/${targets.length}。`);
      if (samples.length >= options.minSamples) {
        const summary = btSummary(samples);
        summaries.push({ 代码: target.code, 名称: target.name, ...summary });
      } else {
        logMessage(`   ${target.code}：样本少于最低要求 ${options.minSamples}，不计入单股汇总。`);
      }
      return true;
    }, tokenValue);
    check(tokenValue);
    const aggregate = btSummary(allSamples);
    if (aggregate) summaries.unshift({ 代码: "全部", 名称: "合计", ...aggregate });
    btRenderSummary(summaries, allSamples);
    logMessage(`T+1 回测完成：共 ${allSamples.length} 个历史触发样本。`);
    if (aggregate) {
      logMessage(`合计：次日高开率 ${aggregate.次日高开率}，高开≥1% ${aggregate["高开≥1%"]}，高开≥2% ${aggregate["高开≥2%"]}。`);
    }
    setStatus(`T+1 回测完成：${allSamples.length} 个历史样本`);
  } catch (error) {
    if (!tokenValue.stopped) {
      logMessage(`T+1 回测失败：${error.message}`);
      setStatus(`T+1 回测失败：${error.message}`);
    } else {
      logMessage("T+1 回测已停止。");
      setStatus("T+1 回测已停止");
    }
  } finally {
    window.__backtestToken = null;
    button.textContent = "开始 T+1 回测";
  }
}

document.querySelector("#backtestButton").addEventListener("click", runT1Backtest);
