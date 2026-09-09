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
  const minEl = document.querySelector("#btPctMin");
  const maxEl = document.querySelector("#btPctMax");
  const minPct = minEl ? btNumber(minEl.value) : 3;
  const maxPct = maxEl ? btNumber(maxEl.value) : 5;
  return {
    minPct: Number.isFinite(minPct) ? minPct : 3,
    maxPct: Number.isFinite(maxPct) ? maxPct : 5,
    requireMa: checked("btMaBullish"),
    requireNearHigh: checked("btNearHigh"),
    nearHigh: Math.max(0.01, Math.min(1, btNumber(document.querySelector("#btNearHighPct")?.value) / 100 || 0.97)),
    requireLimitUp: checked("btLimitUp"),
    limitUpDays: Math.max(1, btNumber(document.querySelector("#btLimitUpDays")?.value) || 20),
    minSamples: Math.max(1, btNumber(document.querySelector("#btMinSamples")?.value) || 1)
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

const GAP_LOOKBACK = BACKTEST_DEFAULT_LOOKBACK;
const GAP_MIN_SAMPLES = 8;
const GAP_TOP_N = 10;
const GAP_K = 20;
const GAP_PRIOR = 4;
const GAP_FEATURE_START = 20;
const GAP_FEATURE_WEIGHTS = [1.6, 0.8, 1.0, 1.0, 0.6];
const GAP_CONFIRM_LIMIT = 80;
const GAP_OWN_WEIGHT = 0.65;
const GAP_MARKET_WEIGHT = 0.35;

function gapClip(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function gapDayFeatures(history, index) {
  if (index < GAP_FEATURE_START) return null;
  const rows = history.slice(0, index + 1);
  const day = rows[rows.length - 1];
  if (!day?.close) return null;
  let pct = Number.isFinite(day.pct) ? day.pct : 0;
  if (!Number.isFinite(day.pct) && rows.length >= 2 && rows[rows.length - 2].close) {
    pct = (day.close / rows[rows.length - 2].close - 1) * 100;
  }
  const volumes = rows.map((x) => btNumber(x.volume));
  const vol = volumes[volumes.length - 1];
  const baseSlice = volumes.slice(-6, -1);
  const volBase = baseSlice.length
    ? baseSlice.reduce((a, b) => a + b, 0) / baseSlice.length
    : volumes.slice(0, -1).reduce((a, b) => a + b, 0) / Math.max(1, volumes.length - 1);
  const volRel = gapClip(volBase > 0 ? vol / volBase : 1, 0.2, 8);
  const closes = rows.map((x) => btNumber(x.close));
  const ma5 = closes.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, closes.length);
  const ma5Bias = ma5 > 0 ? (day.close - ma5) / ma5 * 100 : 0;
  const highs = rows.slice(-20).map((x) => btNumber(x.high || x.close));
  const high20 = Math.max(...highs);
  const nearHigh = high20 > 0 ? day.close / high20 * 100 : 100;
  const body = (day.close - btNumber(day.open || day.close)) / day.close * 100;
  return [pct, volRel, ma5Bias, nearHigh, body];
}

function gapFeatureScale(samples) {
  const dim = samples[0].length;
  const means = [];
  const stds = [];
  for (let j = 0; j < dim; j += 1) {
    const col = samples.map((row) => row[j]);
    const mean = col.reduce((a, b) => a + b, 0) / col.length;
    const variance = col.reduce((a, x) => a + (x - mean) ** 2, 0) / col.length;
    means.push(mean);
    stds.push(variance > 1e-8 ? Math.sqrt(variance) : 1);
  }
  return { means, stds };
}

function gapDistance(left, right, means, stds) {
  let total = 0;
  for (let i = 0; i < GAP_FEATURE_WEIGHTS.length; i += 1) {
    const z1 = (left[i] - means[i]) / stds[i];
    const z2 = (right[i] - means[i]) / stds[i];
    total += GAP_FEATURE_WEIGHTS[i] * (z1 - z2) ** 2;
  }
  return Math.sqrt(total);
}

function collectGapPool(history, code, name) {
  if (!history || !history.length) {
    return { todayFeat: null, pool: [], reason: "未取到日K线，可能停牌、退市或行情接口失败" };
  }
  if (history.length < GAP_FEATURE_START + 1) {
    return { todayFeat: null, pool: [], reason: `日K只有 ${history.length} 根，至少需要 ${GAP_FEATURE_START + 1} 根` };
  }
  const todayIdx = history.length - 1;
  const todayFeat = gapDayFeatures(history, todayIdx);
  if (!todayFeat) return { todayFeat: null, pool: [], reason: "今日形态无法计算" };
  const pool = [];
  for (let i = GAP_FEATURE_START; i < todayIdx; i += 1) {
    const feat = gapDayFeatures(history, i);
    const day = history[i];
    const next = history[i + 1];
    if (!feat || !day?.close || !next?.open) continue;
    const openPct = (next.open / day.close - 1) * 100;
    pool.push({
      index: i,
      todayIdx,
      feat,
      openPct,
      sample: {
        代码: code,
        名称: name,
        日期: day.date,
        次日: next.date,
        当日涨幅: btPct(feat[0]),
        次日开盘涨跌: btPct(openPct),
        次日最高涨跌: btPct((next.high / day.close - 1) * 100),
        次日收盘涨跌: btPct((next.close / day.close - 1) * 100)
      }
    });
  }
  return { todayFeat, pool, reason: "" };
}

function scoreGapPool(todayFeat, pool) {
  if (!todayFeat || pool.length < GAP_MIN_SAMPLES) return null;
  const { means, stds } = gapFeatureScale([...pool.map((x) => x.feat), todayFeat]);
  pool.forEach((item) => {
    const dist = gapDistance(item.feat, todayFeat, means, stds);
    const age = (item.todayIdx || item.index + 1) - item.index;
    item.dist = dist;
    item.weight = (1 / (dist + 0.15)) * Math.exp(-age / 90);
  });
  const neighbors = [...pool].sort((a, b) => a.dist - b.dist).slice(0, GAP_K);
  const weightSum = neighbors.reduce((a, x) => a + x.weight, 0);
  if (weightSum <= 0) return null;
  const weightedRate = (threshold) => neighbors.reduce((a, x) => a + (x.openPct >= threshold ? x.weight : 0), 0) / weightSum * 100;
  const knnP0 = weightedRate(0);
  const uncond = pool.filter((x) => x.openPct >= 0).length / pool.length * 100;
  const n = neighbors.length;
  return {
    次日高开概率: btPct((n * knnP0 + GAP_PRIOR * uncond) / (n + GAP_PRIOR)),
    相似样本: n,
    "高开≥1%": btPct(weightedRate(1)),
    "高开≥2%": btPct(weightedRate(2)),
    平均开盘涨跌: btPct(neighbors.reduce((a, x) => a + x.weight * x.openPct, 0) / weightSum),
    历史高开率: btPct(uncond),
    samples: neighbors.map((x) => ({ ...x.sample, 形态距离: btPct(x.dist, 3) }))
  };
}

function predictNextGap(history, code, name, spotPct) {
  const collected = collectGapPool(history, code, name);
  if (!collected.todayFeat) return { row: null, samples: [], todayFeat: null, reason: collected.reason };
  const scored = scoreGapPool(collected.todayFeat, collected.pool);
  const todayPct = Number.isFinite(spotPct) ? spotPct : collected.todayFeat[0];
  if (!scored) {
    return {
      row: null,
      samples: [],
      todayFeat: collected.todayFeat,
      reason: `本股可对比历史日只有 ${collected.pool.length} 个，少于 ${GAP_MIN_SAMPLES} 个`
    };
  }
  return {
    row: {
      代码: code,
      名称: name,
      当日涨跌幅: `${btPct(todayPct)}%`,
      次日高开概率: `${scored.次日高开概率}%`,
      本股相似概率: `${scored.次日高开概率}%`,
      相似样本: scored.相似样本,
      "高开≥1%": `${scored["高开≥1%"]}%`,
      "高开≥2%": `${scored["高开≥2%"]}%`,
      平均开盘涨跌: `${scored.平均开盘涨跌}%`,
      历史高开率: `${scored.历史高开率}%`
    },
    samples: scored.samples,
    todayFeat: collected.todayFeat,
    reason: ""
  };
}

function gapRankValue(row) {
  return [
    btNumber(String(row.次日高开概率).replace("%", "")),
    btNumber(String(row["高开≥1%"]).replace("%", "")),
    btNumber(String(row.平均开盘涨跌).replace("%", "")),
    btNumber(row.相似样本)
  ];
}

function gapBetter(a, b) {
  const av = gapRankValue(a);
  const bv = gapRankValue(b);
  for (let i = 0; i < av.length; i += 1) {
    if (av[i] !== bv[i]) return av[i] > bv[i];
  }
  return false;
}

async function runGapOne() {
  const button = document.querySelector("#gapOneButton");
  if (window.__gapToken) {
    btStop(window.__gapToken);
    setStatus("正在停止高开概率计算...");
    logMessage("高开概率：已发出停止请求。");
    return;
  }
  const codeText = document.querySelector("#btCodes").value.trim();
  if (!codeText) {
    setStatus("请先输入股票代码");
    logMessage("计算高开概率失败：请先输入股票代码。");
    return;
  }
  const tokenValue = token();
  window.__gapToken = tokenValue;
  button.textContent = "停止计算";
  setStatus("正在计算高开概率...");
  clearLog();
  logMessage("===== 开始计算次日高开概率 =====");
  logMessage("规则：先按本股相似日估计，再用活跃股相似历史日做市场确认。");
  try {
    const targets = codeText.split(/[ ,，\n]+/).filter(Boolean).map((code) => ({
      code: code.padStart(6, "0"), name: ""
    }));
    logMessage(`已指定 ${targets.length} 只股票：${targets.map((x) => x.code).join("、")}`);
    const rows = [];
    const allSamples = [];
    let finished = 0;
    await mapLimit(targets, 1, async (target) => {
      check(tokenValue);
      logMessage(`计算 ${finished + 1}/${targets.length}：${target.code}`);
      const history = await fetchKline(target.code, tokenValue);
      check(tokenValue);
      const predicted = predictNextGap(history, target.code, "");
      if (predicted.reason && !predicted.row) {
        logMessage(`   ${target.code}：${predicted.reason}`);
      } else if (predicted.row) {
        logMessage(`   本股相似概率 ${predicted.row.本股相似概率}（相似 ${predicted.row.相似样本} 日，历史高开率 ${predicted.row.历史高开率}）。`);
      }
      let market = null;
      let marketSamples = [];
      if (predicted.todayFeat) {
        logMessage("   市场确认：拉取活跃股相似历史日...");
        const spot = await fetchSpot(tokenValue);
        check(tokenValue);
        const others = spot.filter((row) => row.code !== target.code).sort((a, b) => b.amount - a.amount).slice(0, GAP_CONFIRM_LIMIT);
        const marketPool = [];
        let doneCount = 0;
        await mapLimit(others, 4, async (other) => {
          check(tokenValue);
          try {
            const otherHist = await fetchKline(other.code, tokenValue);
            collectGapPool(otherHist, other.code, other.name).pool.forEach((item) => marketPool.push(item));
          } catch (error) {
            if (!tokenValue.stopped) logMessage(`   ${other.code}：${error.message}`);
          }
          doneCount += 1;
          if (doneCount % 20 === 0 || doneCount === others.length) {
            logMessage(`   市场确认进度 ${doneCount}/${others.length}，已收集 ${marketPool.length} 个历史日`);
          }
          return true;
        }, tokenValue);
        market = scoreGapPool(predicted.todayFeat, marketPool);
        if (market) {
          marketSamples = market.samples || [];
          logMessage(`   市场确认概率 ${market.次日高开概率}%（相似 ${market.相似样本} 日）`);
        } else {
          logMessage(`   市场确认：相似历史日不足（${marketPool.length}）`);
        }
      }
      finished += 1;
      let row = predicted.row;
      const ownSamples = predicted.samples || [];
      if (!row && market && predicted.todayFeat) {
        row = {
          代码: target.code,
          名称: "",
          当日涨跌幅: `${btPct(predicted.todayFeat[0])}%`,
          次日高开概率: `${market.次日高开概率}%`,
          本股相似概率: "",
          相似样本: 0,
          "高开≥1%": `${market["高开≥1%"]}%`,
          "高开≥2%": `${market["高开≥2%"]}%`,
          平均开盘涨跌: `${market.平均开盘涨跌}%`,
          历史高开率: ""
        };
      }
      if (!row) {
        logMessage(`   ${target.code}：无法估计次日高开概率`);
        return null;
      }
      if (market) {
        const ownP = btNumber(String(row.本股相似概率 || "").replace("%", ""));
        const mktP = btNumber(String(market.次日高开概率).replace("%", ""));
        const combined = ownP > 0 ? GAP_OWN_WEIGHT * ownP + GAP_MARKET_WEIGHT * mktP : mktP;
        row.市场确认概率 = `${btPct(mktP)}%`;
        row.市场相似样本 = market.相似样本;
        row.次日高开概率 = `${btPct(combined)}%`;
        row.确认 = Math.abs((ownP || mktP) - mktP) >= 15 ? "分歧" : "接近";
        ownSamples.push(...marketSamples.slice(0, 10));
      } else {
        row.确认 = "仅本股";
      }
      ownSamples.forEach((x) => allSamples.push(x));
      rows.push(row);
      const extra = row.市场确认概率 ? `，市场确认 ${row.市场确认概率}（${row.确认}）` : "";
      logMessage(`   ${target.code}：次日高开概率 ${row.次日高开概率}${extra}`);
      return row;
    }, tokenValue);
    check(tokenValue);
    if (!rows.length) throw new Error("没有可计算高开概率的股票");
    btRenderSummary(rows, allSamples);
    if (typeof state !== "undefined") state.exportRows = rows;
    setStatus(`高开概率计算完成：${rows.length} 只`);
    logMessage("高开概率计算完成。");
  } catch (error) {
    if (!tokenValue.stopped) {
      logMessage(`高开概率计算失败：${error.message}`);
      setStatus(`高开概率计算失败：${error.message}`);
    } else {
      logMessage("高开概率计算已停止。");
      setStatus("高开概率计算已停止");
    }
  } finally {
    window.__gapToken = null;
    button.textContent = "计算高开概率";
  }
}

async function runGapScan() {
  const button = document.querySelector("#gapScanButton");
  if (window.__gapScanToken) {
    btStop(window.__gapScanToken);
    setStatus("正在停止全盘高开扫描...");
    logMessage("全盘扫描：已发出停止请求。");
    return;
  }
  const tokenValue = token();
  window.__gapScanToken = tokenValue;
  button.textContent = "停止扫描";
  setStatus("正在全盘扫描高开概率...");
  clearLog();
  logMessage("===== 开始全盘扫描次日高开概率前十 =====");
  logMessage(`规则：按今日形态匹配历史相似日；相似样本少于 ${GAP_MIN_SAMPLES} 不进榜；排除 ST/退市。`);
  try {
    const spot = await fetchSpot(tokenValue);
    check(tokenValue);
    const targets = spot.filter((row) => row.price > 0);
    if (!targets.length) throw new Error("没有可扫描的股票");
    logMessage(`全盘 ${targets.length} 只；首次扫描较慢，可随时取消。`);
    const summaries = [];
    let finished = 0;
    let failed = 0;
    await mapLimit(targets, 4, async (target) => {
      check(tokenValue);
      try {
        const history = await fetchKline(target.code, tokenValue);
        check(tokenValue);
        const predicted = predictNextGap(history, target.code, target.name, target.pct);
        const row = predicted.row;
        finished += 1;
        if (row && row.相似样本 >= GAP_MIN_SAMPLES) summaries.push(row);
        if (finished % 100 === 0 || finished === targets.length) {
          logMessage(`进度 ${finished}/${targets.length}，有效 ${summaries.length} 只${failed ? `，失败 ${failed}` : ""}。`);
        }
        return row;
      } catch (error) {
        finished += 1;
        failed += 1;
        if (finished <= 8 || finished % 200 === 0) {
          logMessage(`   ${target.code}：${error.message}`);
        }
        return null;
      }
    }, tokenValue);
    check(tokenValue);
    if (!summaries.length) throw new Error("没有满足最少样本数的股票");
    summaries.sort((a, b) => (gapBetter(a, b) ? -1 : gapBetter(b, a) ? 1 : 0));
    const top = summaries.slice(0, GAP_TOP_N).map((row, index) => ({ 排名: index + 1, ...row }));
    top.forEach((row) => {
      logMessage(`前十 ${row.排名}. ${row.代码} ${row.名称}  次日高开概率 ${row.次日高开概率}（相似 ${row.相似样本} 日）`);
    });
    btRenderSummary(top, []);
    if (typeof state !== "undefined") state.exportRows = top;
    logMessage(`全盘次日高开概率扫描完成：有效 ${summaries.length} 只，已列出前 ${top.length}。`);
    setStatus(`全盘扫描完成：前 ${top.length} 只`);
  } catch (error) {
    if (!tokenValue.stopped) {
      logMessage(`全盘扫描失败：${error.message}`);
      setStatus(`全盘扫描失败：${error.message}`);
    } else {
      logMessage("全盘扫描已停止。");
      setStatus("全盘扫描已停止");
    }
  } finally {
    window.__gapScanToken = null;
    button.textContent = "全盘扫描前十";
  }
}

document.querySelector("#gapOneButton").addEventListener("click", runGapOne);
document.querySelector("#gapScanButton").addEventListener("click", runGapScan);
