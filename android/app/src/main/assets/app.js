const API = {
  clist: "https://push2delay.eastmoney.com/api/qt/clist/get",
  kline: "https://push2his.eastmoney.com/api/qt/stock/kline/get",
  trend: "https://push2delay.eastmoney.com/api/qt/stock/trends2/get"
};

const state = {
  pending: new Map(),
  nextId: 1,
  screen: null,
  monitor: null,
  similar: null,
  screenRows: [],
  similarRows: [],
  exportRows: [],
  hotCodes: null,
  hotCodesAt: 0
};

window.__marketResolve = (id, success, body) => {
  const request = state.pending.get(id);
  if (!request) return;
  state.pending.delete(id);
  request.token?.ids.delete(id);
  if (success) {
    try {
      request.resolve(JSON.parse(body));
    } catch (_) {
      request.reject(new Error("行情接口返回格式错误"));
    }
  } else {
    request.reject(new Error(body || "网络请求失败"));
  }
};

function buildUrl(url, params) {
  const query = new URLSearchParams(params);
  return `${url}?${query.toString()}`;
}

function token() {
  return { stopped: false, ids: new Set() };
}

function check(tokenValue) {
  if (tokenValue?.stopped) throw new Error("分析已停止");
}

function stopToken(tokenValue) {
  if (!tokenValue) return;
  tokenValue.stopped = true;
  for (const id of tokenValue.ids) {
    if (window.MarketAPI) window.MarketAPI.cancel(id);
  }
  tokenValue.ids.clear();
}

function getJson(url, params, tokenValue) {
  check(tokenValue);
  if (!window.MarketAPI) {
    return fetch(buildUrl(url, params)).then((response) => {
      if (!response.ok) throw new Error(`网络请求失败：${response.status}`);
      return response.json();
    });
  }
  const id = `request_${state.nextId++}`;
  return new Promise((resolve, reject) => {
    state.pending.set(id, { resolve, reject, token: tokenValue });
    tokenValue?.ids.add(id);
    window.MarketAPI.get(buildUrl(url, params), id);
  });
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function secid(code) {
  return /^[69]/.test(String(code).padStart(6, "0"))
    ? `1.${String(code).padStart(6, "0")}`
    : `0.${String(code).padStart(6, "0")}`;
}

async function fetchClist(fs, fields, tokenValue) {
  const rows = [];
  let page = 1;
  while (true) {
    check(tokenValue);
    const data = await getJson(API.clist, {
      pn: page,
      pz: 100,
      po: 1,
      np: 1,
      fltt: 2,
      invt: 2,
      fid: "f3",
      fs,
      fields,
      ut: "bd1d9ddb04089700cf9c27f6f7426281"
    }, tokenValue);
    const block = data?.data || {};
    const diff = Array.isArray(block.diff) ? block.diff : Object.values(block.diff || {});
    rows.push(...diff);
    if (!diff.length || rows.length >= number(block.total)) break;
    page += 1;
  }
  return rows;
}

async function fetchSpot(tokenValue) {
  const fields = "f12,f14,f2,f3,f6,f8,f9,f10,f15,f16,f17,f18,f20,f21,f23,f62";
  const raw = await fetchClist(
    "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81,m:1+t:13",
    fields,
    tokenValue
  );
  return raw.map((row) => ({
    code: String(row.f12 || "").padStart(6, "0"),
    name: String(row.f14 || ""),
    price: number(row.f2),
    pct: number(row.f3),
    amount: number(row.f6),
    turnover: number(row.f8),
    pe: number(row.f9),
    volumeRatio: number(row.f10),
    floatMarketValue: number(row.f21) / 1e8,
    mainInflow: number(row.f62)
  })).filter((row) => row.price > 0 && !/ST|退/i.test(row.name));
}

async function fetchKline(code, tokenValue) {
  const data = await getJson(API.kline, {
    secid: secid(code),
    klt: 101,
    fqt: 1,
    beg: 0,
    lmt: 120,
    end: 20500101,
    fields1: "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13",
    fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61"
  }, tokenValue);
  return (data?.data?.klines || []).map((item) => {
    const values = item.split(",");
    return {
      date: values[0],
      open: number(values[1]),
      close: number(values[2]),
      high: number(values[3]),
      low: number(values[4]),
      volume: number(values[5]),
      amount: number(values[6]),
      pct: number(values[8])
    };
  }).filter((row) => row.close > 0);
}

async function fetchTrend(code, tokenValue) {
  const data = await getJson(API.trend, {
    secid: secid(code),
    fields1: "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13",
    fields2: "f51,f52,f53,f54,f55,f56,f57,f58",
    iscr: 0,
    ndays: 1
  }, tokenValue);
  return (data?.data?.trends || []).map((item) => {
    const values = item.split(",");
    return {
      time: values[0],
      open: number(values[1]),
      close: number(values[2]),
      high: number(values[3]),
      low: number(values[4]),
      volume: number(values[5]),
      amount: number(values[6]),
      vwap: number(values[7])
    };
  }).filter((row) => row.close > 0);
}

async function fetchIndexPct(tokenValue) {
  const data = await getJson(API.trend, {
    secid: "1.000001",
    fields1: "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13",
    fields2: "f51,f52,f53,f54,f55,f56,f57,f58",
    iscr: 0,
    ndays: 1
  }, tokenValue);
  const preClose = number(data?.data?.preClose);
  const rows = data?.data?.trends || [];
  if (!preClose || !rows.length) return 0;
  const last = number(rows[rows.length - 1].split(",")[2]);
  return last ? (last / preClose - 1) * 100 : 0;
}

async function fetchHotCodes(tokenValue, topN = 10) {
  if (state.hotCodes && Date.now() - state.hotCodesAt < 30 * 60 * 1000) {
    return state.hotCodes;
  }
  const fields = "f12,f14,f3";
  const skipWords = /昨日|涨停|连板|打板|打二板|历史新高|跌停|炸板|题材股/;
  const boards = [];
  for (const [fs, type] of [["m:90+t:3+f:!50", "概念"], ["m:90+t:2+f:!50", "行业"]]) {
    const rows = await fetchClist(fs, fields, tokenValue);
    boards.push(...rows
      .filter((row) => !skipWords.test(String(row.f14 || "")))
      .sort((a, b) => number(b.f3) - number(a.f3))
      .slice(0, topN)
      .map((row) => ({ code: String(row.f12), name: String(row.f14 || ""), type })));
  }
  const codes = new Set();
  for (const board of boards) {
    const members = await fetchClist(`b:${board.code}+f:!50`, "f12,f14", tokenValue);
    members.forEach((row) => codes.add(String(row.f12 || "").padStart(6, "0")));
  }
  state.hotCodes = codes;
  state.hotCodesAt = Date.now();
  return codes;
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function rapidMetrics(rows, options) {
  const startAt = options.skipOpen;
  const window = options.rapidWindow;
  if (!rows || rows.length <= startAt + window) return null;
  const body = rows.slice(startAt);
  let best = null;
  for (let end = window; end < body.length; end += 1) {
    const start = end - window;
    const base = body[start].close;
    const close = body[end].close;
    if (base <= 0 || close <= 0) continue;
    const segment = body.slice(start + 1, end + 1);
    const outside = body.slice(0, start).concat(body.slice(end + 1)).map((row) => row.volume);
    const baseline = median(outside) || median(body.map((row) => row.volume));
    const volumeMultiple = baseline ? segment.reduce((sum, row) => sum + row.volume, 0) / segment.length / baseline : 0;
    const item = {
      pct: (close / base - 1) * 100,
      volumeMultiple,
      start: body[start].time,
      end: body[end].time
    };
    if (!best || item.pct > best.pct) best = item;
  }
  return best;
}

function movingAverage(rows, size) {
  return rows.slice(-size).reduce((sum, row) => sum + row.close, 0) / size;
}

function isLimitUp(code, name, rows) {
  const threshold = /ST|退/i.test(name) ? 4.8 : /^(300|301|688)/.test(code) ? 19.5 : /^(8|4)/.test(code) ? 29.5 : 9.5;
  return rows.slice(-20).some((row) => row.pct >= threshold);
}

function isVolumeStair(rows) {
  const values = rows.slice(-5).map((row) => row.volume);
  return values.length === 5 && values.every((value, index) => index === 0 || value > values[index - 1]);
}

function isAboveVwap(rows) {
  const body = rows.slice(5);
  return body.length > 0 && body.every((row) => row.close >= row.vwap) &&
    body[body.length - 1].close >= body[body.length - 1].vwap;
}

function isTailHigh(rows) {
  if (!rows.length) return false;
  const high = Math.max(...rows.map((row) => row.high));
  const after = rows.filter((row) => {
    const time = row.time.slice(11, 16);
    return time >= "14:30";
  });
  return after.length > 0 && Math.max(...after.map((row) => row.high)) >= high * 0.999 &&
    rows[rows.length - 1].close >= high * 0.992;
}

function analyzeStock(row, options, tokenValue) {
  return Promise.all([fetchKline(row.code, tokenValue), fetchTrend(row.code, tokenValue)])
    .then(([history, trends]) => {
      check(tokenValue);
      if (history.length < 62 || trends.length < 6) return null;
      const ma5 = movingAverage(history, 5);
      const ma10 = movingAverage(history, 10);
      const ma20 = movingAverage(history, 20);
      const ma60 = movingAverage(history, 60);
      const rapid = rapidMetrics(trends, options);
      if (!isLimitUp(row.code, row.name, history) ||
          !isVolumeStair(history) ||
          !(ma5 > ma10 && ma10 > ma20 && ma20 > ma60 && row.price > ma5) ||
          (row.price - ma5) / ma5 > 0.07 ||
          history[history.length - 1].low < Math.min(...history.slice(-16, -1).map((item) => item.low)) ||
          row.price < Math.max(...history.slice(-20).map((item) => item.high)) * 0.97 ||
          !rapid ||
          rapid.pct < options.rapidPct ||
          rapid.volumeMultiple < options.rapidVolume ||
          !isAboveVwap(trends) ||
          (options.tailHigh && !isTailHigh(trends))) return null;
      return {
        代码: row.code,
        名称: row.name,
        最新价: row.price.toFixed(3),
        涨跌幅: row.pct.toFixed(2),
        换手率: row.turnover.toFixed(2),
        量比: row.volumeRatio.toFixed(2),
        急拉涨幅: rapid.pct.toFixed(2),
        急拉放量: rapid.volumeMultiple.toFixed(2),
        急拉时段: `${rapid.start} 至 ${rapid.end}`
      };
    });
}

async function mapLimit(rows, limit, callback, tokenValue, success) {
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < rows.length) {
      check(tokenValue);
      const row = rows[cursor++];
      try {
        const value = await callback(row);
        if (value) {
          results.push(value);
          success?.(value);
        }
      } catch (error) {
        if (!tokenValue?.stopped) logMessage(`${row.code || ""}：${error.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, rows.length) }, worker));
  return results;
}

async function runScreen(live, tokenValue, update) {
  const options = readOptions();
  options.tailHigh = !live && new Date().toTimeString().slice(0, 5) >= "14:30";
  const spot = await fetchSpot(tokenValue);
  let candidates = spot.filter((row) =>
    row.pct >= options.pctMin &&
    row.pct <= options.pctMax &&
    row.turnover >= options.turnoverMin &&
    row.turnover <= options.turnoverMax &&
    row.volumeRatio > options.volumeRatioMin &&
    row.floatMarketValue >= 50 &&
    row.floatMarketValue <= 200 &&
    row.pe > 0 &&
    row.mainInflow > 0
  ).sort((a, b) => b.amount - a.amount);
  const hotCodes = await fetchHotCodes(tokenValue);
  candidates = candidates.filter((row) => hotCodes.has(row.code));
  const indexPct = await fetchIndexPct(tokenValue);
  candidates = candidates.filter((row) => row.pct > indexPct).slice(0, options.screenLimit);
  logMessage(`候选 ${candidates.length} 只，开始复检${live ? "（实时）" : ""}...`);
  const results = await mapLimit(
    candidates,
    4,
    (row) => analyzeStock(row, options, tokenValue),
    tokenValue,
    (value) => {
      update(value);
      state.screenRows.push(value);
      renderResults(state.screenRows);
    }
  );
  return results.sort((a, b) => Number(b.涨跌幅) - Number(a.涨跌幅));
}

function zscore(values) {
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const deviation = Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
  return deviation ? values.map((value) => (value - average) / deviation) : values.map(() => 0);
}

function similarityScore(target, candidate) {
  const targetBase = target[0].close;
  const candidateBase = candidate[0].close;
  if (!targetBase || !candidateBase) return 0;
  const targetPath = target.map((row) => row.close / targetBase);
  const candidatePath = candidate.map((row) => row.close / candidateBase);
  const pathError = Math.sqrt(targetPath.reduce((sum, value, i) => sum + (value - candidatePath[i]) ** 2, 0) / target.length);
  const targetReturns = target.map((row, i) => i ? row.close / target[i - 1].close - 1 : 0);
  const candidateReturns = candidate.map((row, i) => i ? row.close / candidate[i - 1].close - 1 : 0);
  const returnError = Math.sqrt(targetReturns.reduce((sum, value, i) => sum + (value - candidateReturns[i]) ** 2, 0) / target.length);
  const targetVolume = zscore(target.map((row) => Math.log1p(row.volume)));
  const candidateVolume = zscore(candidate.map((row) => Math.log1p(row.volume)));
  const volumeError = Math.sqrt(targetVolume.reduce((sum, value, i) => sum + (value - candidateVolume[i]) ** 2, 0) / target.length);
  return Math.max(0, Math.min(100, 100 * (0.6 * Math.exp(-8 * pathError) + 0.25 * Math.exp(-12 * returnError) + 0.15 * Math.exp(-0.35 * volumeError))));
}

function bestMatches(targetHistory, candidateHistory, code, name, windows) {
  const matches = [];
  for (const window of windows) {
    if (candidateHistory.length < window + 11) continue;
    const target = targetHistory.slice(-window);
    let best = null;
    for (let end = window - 1; end < candidateHistory.length - 10; end += 1) {
      const segment = candidateHistory.slice(end - window + 1, end + 1);
      const score = similarityScore(target, segment);
      if (!best || score > best.相似度) {
        const base = candidateHistory[end].close;
        const forward = (days) => candidateHistory[end + days]
          ? (candidateHistory[end + days].close / base - 1) * 100 : null;
        best = {
          窗口: `${window}日`,
          代码: code,
          名称: name,
          相似度: score.toFixed(2),
          匹配区间: `${segment[0].date} 至 ${segment[segment.length - 1].date}`,
          后1日涨跌: forward(1)?.toFixed(2) ?? "",
          后3日涨跌: forward(3)?.toFixed(2) ?? "",
          后5日涨跌: forward(5)?.toFixed(2) ?? "",
          后10日涨跌: forward(10)?.toFixed(2) ?? ""
        };
      }
    }
    if (best) matches.push(best);
  }
  return matches;
}

async function runSimilarity(tokenValue, update) {
  const code = document.querySelector("#similarCode").value.trim().padStart(6, "0");
  const candidateLimit = Number(document.querySelector("#similarLimit").value);
  const topN = Number(document.querySelector("#similarTopN").value);
  const selected = document.querySelector("#similarWindow").value;
  if (!/^\d{6}$/.test(code)) throw new Error("股票代码必须是 6 位数字");
  if (!Number.isInteger(candidateLimit) || candidateLimit < 0 || !Number.isInteger(topN) || topN < 1) {
    throw new Error("候选数量不能为负数，返回数量必须大于 0");
  }
  const windows = selected === "全部" ? [5, 10, 20, 60] : [Number(selected)];
  const target = await fetchKline(code, tokenValue);
  const spot = await fetchSpot(tokenValue);
  let candidates = spot.sort((a, b) => b.amount - a.amount);
  if (candidateLimit) candidates = candidates.slice(0, candidateLimit);
  const top = Object.fromEntries(windows.map((window) => [window, []]));
  const addMatches = (matches) => {
    for (const match of matches) {
      const window = Number(match.窗口.replace("日", ""));
      top[window].push(match);
      top[window].sort((a, b) => Number(b.相似度) - Number(a.相似度));
      top[window] = top[window].slice(0, topN);
    }
    const partial = windows.flatMap((window) => top[window]);
    state.similarRows = partial;
    update(partial);
    renderResults(partial);
  };
  logMessage(`开始分析${candidateLimit ? `活跃候选前 ${candidateLimit} 只` : "全 A 股"}...`);
  await mapLimit(
    candidates,
    4,
    async (row) => bestMatches(target, await fetchKline(row.code, tokenValue), row.code, row.name, windows),
    tokenValue,
    (matches) => addMatches(matches)
  );
  return windows.flatMap((window) => top[window]);
}

function readOptions() {
  const value = (id) => Number(document.querySelector(`#${id}`).value);
  return {
    pctMin: value("pctMin"),
    pctMax: value("pctMax"),
    turnoverMin: value("turnoverMin"),
    turnoverMax: value("turnoverMax"),
    volumeRatioMin: value("volumeRatioMin"),
    monitorInterval: Math.max(1, value("monitorInterval")),
    rapidWindow: Math.max(1, value("rapidWindow")),
    rapidPct: Math.max(0, value("rapidPct")),
    rapidVolume: Math.max(0, value("rapidVolume")),
    screenLimit: Math.max(1, value("screenLimit")),
    skipOpen: 5
  };
}

function logMessage(message) {
  const log = document.querySelector("#log");
  log.textContent = `${log.textContent.split("\n").filter(Boolean).slice(-11).join("\n")}\n${message}`.trim();
  log.scrollTop = log.scrollHeight;
}

function renderResults(rows) {
  const container = document.querySelector("#results");
  state.exportRows = rows || [];
  if (!rows?.length) {
    container.textContent = "暂无结果";
    return;
  }
  const columns = Object.keys(rows[0]);
  const head = columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("");
  const body = rows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(row[column])}</td>`).join("")}</tr>`).join("");
  container.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
}

function csv(rows) {
  if (!rows.length) return "";
  const columns = Object.keys(rows[0]);
  return [columns, ...rows.map((row) => columns.map((column) => row[column] ?? ""))]
    .map((line) => line.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","))
    .join("\n");
}

function saveResult() {
  if (!state.exportRows.length) {
    setStatus("暂无可导出的结果");
    return;
  }
  const filename = `screen_${new Date().toISOString().slice(0, 10).replaceAll("-", "")}.csv`;
  const content = "\ufeff" + csv(state.exportRows);
  if (window.MarketAPI) {
    const id = `save_${state.nextId++}`;
    state.pending.set(id, {
      resolve: (path) => setStatus(`已保存到应用目录：${path}`),
      reject: (error) => setStatus(`保存失败：${error.message}`)
    });
    window.MarketAPI.saveFile(filename, content, id);
  } else {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
    link.download = filename;
    link.click();
    setStatus(`已导出：${filename}`);
  }
}

function setStatus(message) {
  document.querySelector("#status").textContent = message;
}

async function startScreen() {
  if (state.screen) {
    stopToken(state.screen);
    setStatus("正在停止选股...");
    return;
  }
  try {
    state.screen = token();
    state.screenRows = [];
    renderResults([]);
    document.querySelector("#screenButton").textContent = "停止选股";
    setStatus("正在选股...");
    const result = await runScreen(false, state.screen, () => {});
    state.screenRows = result;
    renderResults(result);
  } catch (error) {
    if (!state.screen?.stopped) setStatus(`选股失败：${error.message}`);
  } finally {
    state.screen = null;
    document.querySelector("#screenButton").textContent = "开始选股";
  }
}

async function toggleMonitor() {
  if (state.monitor) {
    stopToken(state.monitor);
    setStatus("正在停止实时监控...");
    return;
  }
  state.monitor = token();
  state.screenRows = [];
  document.querySelector("#monitorButton").textContent = "停止监控";
  setStatus("正在实时监控...");
  try {
    while (!state.monitor.stopped) {
      const result = await runScreen(true, state.monitor, () => {});
      state.screenRows = result;
      renderResults(result);
      await new Promise((resolve) => setTimeout(resolve, readOptions().monitorInterval * 1000));
    }
  } catch (error) {
    if (!state.monitor.stopped) setStatus(`监控失败：${error.message}`);
  } finally {
    state.monitor = null;
    document.querySelector("#monitorButton").textContent = "实时监控";
    setStatus("实时监控已停止");
  }
}

async function startSimilarity() {
  if (state.similar) {
    stopToken(state.similar);
    setStatus("正在停止相似分析...");
    return;
  }
  state.similar = token();
  state.similarRows = [];
  document.querySelector("#similarButton").textContent = "停止分析";
  setStatus("正在分析，相似结果会实时显示...");
  try {
    const result = await runSimilarity(state.similar, () => {});
    state.similarRows = result;
    renderResults(result);
  } catch (error) {
    if (!state.similar?.stopped) setStatus(`相似分析失败：${error.message}`);
  } finally {
    state.similar = null;
    document.querySelector("#similarButton").textContent = "开始分析";
    setStatus("相似分析已停止/完成");
  }
}

document.querySelector("#screenButton").addEventListener("click", startScreen);
document.querySelector("#monitorButton").addEventListener("click", toggleMonitor);
document.querySelector("#similarButton").addEventListener("click", startSimilarity);
document.querySelector("#exportButton").addEventListener("click", saveResult);
