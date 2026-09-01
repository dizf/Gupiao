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
  hotMemberMap: null,
  hotCodesAt: 0,
  hotTopN: 10
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
      // saveFile 返回普通路径字符串，不是 JSON
      if (typeof body === "string" && body && !/^\s*[\[{]/.test(body)) {
        request.resolve(body);
      } else {
        request.reject(new Error("行情接口返回格式错误"));
      }
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

function optionalNumber(id) {
  const text = String(document.querySelector(`#${id}`).value || "").trim();
  if (!text) return null;
  const result = Number(text);
  return Number.isFinite(result) ? result : null;
}

function checked(id) {
  return Boolean(document.querySelector(`#${id}`)?.checked);
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

async function fetchHotBoards(tokenValue, topN) {
  if (
    state.hotCodes &&
    state.hotTopN === topN &&
    Date.now() - state.hotCodesAt < 30 * 60 * 1000
  ) {
    return { codes: state.hotCodes, memberMap: state.hotMemberMap, boards: [] };
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
      .map((row) => ({
        code: String(row.f12),
        name: String(row.f14 || ""),
        pct: number(row.f3),
        type
      })));
  }
  const codes = new Set();
  const memberMap = {};
  for (const board of boards) {
    const members = await fetchClist(`b:${board.code}+f:!50`, "f12,f14", tokenValue);
    members.forEach((row) => {
      const code = String(row.f12 || "").padStart(6, "0");
      codes.add(code);
      if (!memberMap[code]) memberMap[code] = [];
      memberMap[code].push(board.name);
    });
  }
  state.hotCodes = codes;
  state.hotMemberMap = memberMap;
  state.hotCodesAt = Date.now();
  state.hotTopN = topN;
  return { codes, memberMap, boards };
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function rapidMetrics(rows, options) {
  const startAt = options.skipOpenMinutes;
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
    const volumeMultiple = baseline
      ? segment.reduce((sum, row) => sum + row.volume, 0) / segment.length / baseline
      : 0;
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

function maSeries(rows) {
  if (rows.length < 62) return null;
  const closes = rows.map((row) => row.close);
  const avg = (end, size) => {
    let sum = 0;
    for (let i = end - size + 1; i <= end; i += 1) sum += closes[i];
    return sum / size;
  };
  const last = closes.length - 1;
  const prev = last - 1;
  return {
    ma5: avg(last, 5),
    ma10: avg(last, 10),
    ma20: avg(last, 20),
    ma60: avg(last, 60),
    prevMa5: avg(prev, 5),
    prevMa10: avg(prev, 10),
    prevMa20: avg(prev, 20),
    prevMa60: avg(prev, 60),
    close: closes[last]
  };
}

function limitUpThreshold(code, name) {
  if (/ST|退/i.test(name)) return 4.8;
  if (/^(300|301|688)/.test(code)) return 19.5;
  if (/^[84]/.test(code)) return 29.5;
  return 9.5;
}

function hasLimitUpGene(code, name, rows, lookback) {
  const threshold = limitUpThreshold(code, name);
  return rows.slice(-lookback).some((row) => row.pct >= threshold);
}

function isVolumeStair(rows, days) {
  const values = rows.slice(-days).map((row) => row.volume);
  return values.length === days &&
    values.every((value, index) => index === 0 || value > values[index - 1]);
}

function isMaBullish(rows) {
  const mas = maSeries(rows);
  if (!mas) return false;
  const stacked = mas.ma5 > mas.ma10 && mas.ma10 > mas.ma20 && mas.ma20 > mas.ma60;
  const above = mas.close > mas.ma5;
  const sloping =
    mas.ma5 > mas.prevMa5 &&
    mas.ma10 > mas.prevMa10 &&
    mas.ma20 > mas.prevMa20 &&
    mas.ma60 > mas.prevMa60;
  return stacked && above && sloping;
}

function notFarFromMa5(rows, price, maxBias) {
  const mas = maSeries(rows);
  if (!mas || mas.ma5 <= 0 || price < mas.ma5) return false;
  return (price - mas.ma5) / mas.ma5 <= maxBias;
}

function heldPlatform(rows, lookback) {
  if (rows.length < lookback + 1) return false;
  const support = Math.min(...rows.slice(-(lookback + 1), -1).map((row) => row.low));
  return rows[rows.length - 1].low >= support;
}

function near20dHigh(rows, ratio) {
  if (rows.length < 20) return false;
  const high = Math.max(...rows.slice(-20).map((row) => row.high));
  const close = rows[rows.length - 1].close;
  return high > 0 && close >= high * ratio;
}

function isAboveVwap(rows, options) {
  if (!rows.length || rows.length <= options.skipOpenMinutes) return false;
  const body = rows.slice(options.skipOpenMinutes);
  if (!body.length) return false;
  const ratio = body.filter((row) => row.close >= row.vwap).length / body.length;
  const nowAbove = rows[rows.length - 1].close >= rows[rows.length - 1].vwap;
  return nowAbove && ratio >= options.aboveVwapRatio;
}

function isTailHigh(rows) {
  if (!rows.length) return false;
  const high = Math.max(...rows.map((row) => row.high));
  const after = rows.filter((row) => {
    const time = row.time.slice(11, 16);
    return time >= "14:30";
  });
  return after.length > 0 &&
    Math.max(...after.map((row) => row.high)) >= high * 0.999 &&
    rows[rows.length - 1].close >= high * 0.992;
}

function filterBasic(spot, options) {
  return spot.filter((row) => {
    if (options.enablePct && (row.pct < options.pctMin || row.pct > options.pctMax)) return false;
    if (options.enableTurnover &&
        (row.turnover < options.turnoverMin || row.turnover > options.turnoverMax)) return false;
    if (options.enableVolumeRatio) {
      if (!(row.volumeRatio > options.volumeRatioMin)) return false;
      if (options.volumeRatioMax != null && row.volumeRatio > options.volumeRatioMax) return false;
    }
    if (options.enableCircMv &&
        (row.floatMarketValue < options.circMvMin || row.floatMarketValue > options.circMvMax)) {
      return false;
    }
    if (options.enableProfitable && !(row.pe > 0)) return false;
    if (options.enableMainInflow && !(row.mainInflow > 0)) return false;
    return true;
  });
}

async function analyzeStock(row, options, tokenValue) {
  const needsHist = options.enableLimitUp || options.enableVolumeStair ||
    options.enableMaBullish || options.enableMa5Bias ||
    options.enablePlatform || options.enableNearHigh;
  const needsTrend = options.enableVwap || options.enableTailHigh || options.enableRapidRise;
  const [history, trends] = await Promise.all([
    needsHist ? fetchKline(row.code, tokenValue) : Promise.resolve([]),
    needsTrend ? fetchTrend(row.code, tokenValue) : Promise.resolve([])
  ]);
  check(tokenValue);

  if (needsHist && history.length < 62 &&
      (options.enableMaBullish || options.enableMa5Bias)) {
    logMessage(`   排除 ${row.code} ${row.name}：历史 K 线不足`);
    return null;
  }

  if (options.enableLimitUp &&
      !hasLimitUpGene(row.code, row.name, history, options.limitUpLookback)) {
    logMessage(`   排除 ${row.code} ${row.name}：${options.limitUpLookback} 日内无涨停`);
    return null;
  }
  if (options.enableVolumeStair && !isVolumeStair(history, options.volumeStairDays)) {
    logMessage(`   排除 ${row.code} ${row.name}：量能非台阶式放量`);
    return null;
  }
  if (options.enableMaBullish && !isMaBullish(history)) {
    logMessage(`   排除 ${row.code} ${row.name}：均线非 5/10/20/60 多头向上`);
    return null;
  }
  if (options.enableMa5Bias && !notFarFromMa5(history, row.price, options.maxMa5Bias)) {
    logMessage(`   排除 ${row.code} ${row.name}：股价远离5日均线`);
    return null;
  }
  if (options.enablePlatform && !heldPlatform(history, options.platformLookback)) {
    logMessage(`   排除 ${row.code} ${row.name}：已跌破近期平台支撑`);
    return null;
  }
  if (options.enableNearHigh && !near20dHigh(history, options.near20dHigh)) {
    logMessage(`   排除 ${row.code} ${row.name}：上方仍有套牢压力`);
    return null;
  }

  const rapid = options.enableRapidRise ? rapidMetrics(trends, options) : null;
  if (options.enableRapidRise && (
    !rapid ||
    rapid.pct < options.rapidPct ||
    rapid.volumeMultiple < options.rapidVolume
  )) {
    const detail = rapid
      ? `最大${options.rapidWindow}分钟涨幅 ${rapid.pct.toFixed(2)}% / 放量 ${rapid.volumeMultiple.toFixed(2)}倍`
      : "数据不足";
    logMessage(`   排除 ${row.code} ${row.name}：未满足急速拉升（${detail}）`);
    return null;
  }
  if (options.enableVwap && !isAboveVwap(trends, options)) {
    logMessage(`   排除 ${row.code} ${row.name}：分时未全程在均价线上方`);
    return null;
  }
  if (options.enableTailHigh && !isTailHigh(trends)) {
    logMessage(`   排除 ${row.code} ${row.name}：14:30 后未创当日新高`);
    return null;
  }

  const boards = row.hotBoards || [];
  return {
    代码: row.code,
    名称: row.name,
    最新价: row.price.toFixed(3),
    涨跌幅: row.pct.toFixed(2),
    换手率: row.turnover.toFixed(2),
    量比: row.volumeRatio.toFixed(2),
    流通市值_亿: row.floatMarketValue.toFixed(2),
    市盈率: row.pe.toFixed(2),
    主力净流入_亿: (row.mainInflow / 1e8).toFixed(3),
    热点板块: boards.join("、"),
    急拉涨幅: rapid ? rapid.pct.toFixed(2) : "",
    急拉放量: rapid ? rapid.volumeMultiple.toFixed(2) : "",
    急拉时段: rapid ? `${rapid.start} 至 ${rapid.end}` : ""
  };
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
        if (!tokenValue?.stopped) {
          logMessage(`${row.code || ""}：${error.message}`);
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, rows.length || 1) }, worker));
  return results;
}

async function runScreen(live, tokenValue, update) {
  const options = readOptions();
  logMessage(`1/4 拉取行情，过滤基础条件...`);
  const spot = await fetchSpot(tokenValue);
  check(tokenValue);
  logMessage(`   行情 ${spot.length} 只`);
  let candidates = filterBasic(spot, options);
  logMessage(`   基础条件剩余 ${candidates.length} 只`);

  if (options.enableHotBoard) {
    logMessage(`2/4 取涨幅前 ${options.hotBoardTopN} 的热点板块...`);
    const hot = await fetchHotBoards(tokenValue, options.hotBoardTopN);
    check(tokenValue);
    if (hot.boards.length) {
      hot.boards.slice(0, 8).forEach((board) => {
        logMessage(`   ${board.type} ${board.name} ${board.pct.toFixed(2)}%`);
      });
    }
    candidates = candidates
      .map((row) => ({ ...row, hotBoards: hot.memberMap[row.code] || [] }))
      .filter((row) => hot.codes.has(row.code));
    logMessage(`   落在热点板块内 ${candidates.length} 只`);
  } else {
    logMessage("2/4 已关闭热点板块筛选");
    candidates = candidates.map((row) => ({ ...row, hotBoards: [] }));
  }

  if (!candidates.length) {
    logMessage("没有符合当前基础条件的股票。");
    return [];
  }

  if (options.enableStrongerThanIndex) {
    logMessage("3/4 拉取上证指数，用于比较分时强弱...");
    const indexPct = await fetchIndexPct(tokenValue);
    check(tokenValue);
    logMessage(`   上证涨跌幅 ${indexPct.toFixed(2)}%`);
    candidates = candidates.filter((row) => row.pct > indexPct);
    logMessage(`   强于大盘剩余 ${candidates.length} 只`);
    if (!candidates.length) {
      logMessage("没有强于大盘的候选。");
      return [];
    }
  } else {
    logMessage("3/4 已关闭强于大盘筛选");
  }

  candidates = candidates.sort((a, b) => b.amount - a.amount);
  logMessage(`4/4 复检涨停基因 / 台阶放量 / 均线 / 平台 / 分时... 共 ${candidates.length} 只`);
  const results = await mapLimit(
    candidates,
    4,
    (row) => analyzeStock(row, options, tokenValue),
    tokenValue,
    (value) => {
      logMessage(`   命中 ${value.代码} ${value.名称}`);
      update(value);
      state.screenRows.push(value);
      renderResults(state.screenRows.slice().sort((a, b) => Number(b.涨跌幅) - Number(a.涨跌幅)));
    }
  );
  const sorted = results.sort((a, b) => Number(b.涨跌幅) - Number(a.涨跌幅));
  logMessage(`===== 最终结果 ${sorted.length} 只 =====`);
  if (!sorted.length) logMessage("无符合全部条件的股票。");
  return sorted;
}

function zscore(values) {
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const deviation = Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length
  );
  return deviation ? values.map((value) => (value - average) / deviation) : values.map(() => 0);
}

function similarityScore(target, candidate) {
  const targetBase = target[0].close;
  const candidateBase = candidate[0].close;
  if (!targetBase || !candidateBase) return 0;
  const targetPath = target.map((row) => row.close / targetBase);
  const candidatePath = candidate.map((row) => row.close / candidateBase);
  const pathError = Math.sqrt(
    targetPath.reduce((sum, value, i) => sum + (value - candidatePath[i]) ** 2, 0) / target.length
  );
  const targetReturns = target.map((row, i) => (i ? row.close / target[i - 1].close - 1 : 0));
  const candidateReturns = candidate.map((row, i) =>
    (i ? row.close / candidate[i - 1].close - 1 : 0));
  const returnError = Math.sqrt(
    targetReturns.reduce((sum, value, i) => sum + (value - candidateReturns[i]) ** 2, 0) /
      target.length
  );
  const targetVolume = zscore(target.map((row) => Math.log1p(row.volume)));
  const candidateVolume = zscore(candidate.map((row) => Math.log1p(row.volume)));
  const volumeError = Math.sqrt(
    targetVolume.reduce((sum, value, i) => sum + (value - candidateVolume[i]) ** 2, 0) /
      target.length
  );
  return Math.max(
    0,
    Math.min(
      100,
      100 * (
        0.6 * Math.exp(-8 * pathError) +
        0.25 * Math.exp(-12 * returnError) +
        0.15 * Math.exp(-0.35 * volumeError)
      )
    )
  );
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
          ? (candidateHistory[end + days].close / base - 1) * 100
          : null;
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
  if (!Number.isInteger(candidateLimit) || candidateLimit < 0 ||
      !Number.isInteger(topN) || topN < 1) {
    throw new Error("候选数量不能为负数，返回数量必须大于 0");
  }
  const windows = selected === "全部" ? [5, 10, 20, 60] : [Number(selected)];
  clearLog();
  logMessage(`拉取目标股 ${code} 历史K线...`);
  const target = await fetchKline(code, tokenValue);
  if (target.length < Math.max(...windows)) {
    throw new Error("目标股历史数据不足");
  }
  logMessage("拉取全市场行情...");
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
    async (row) => bestMatches(
      target,
      await fetchKline(row.code, tokenValue),
      row.code,
      row.name,
      windows
    ),
    tokenValue,
    (matches) => addMatches(matches)
  );
  return windows.flatMap((window) => top[window]);
}

function readOptions() {
  const value = (id) => Number(document.querySelector(`#${id}`).value);
  const volumeRatioMax = optionalNumber("volumeRatioMax");
  const options = {
    enablePct: checked("enablePct"),
    pctMin: value("pctMin"),
    pctMax: value("pctMax"),
    enableTurnover: checked("enableTurnover"),
    turnoverMin: value("turnoverMin"),
    turnoverMax: value("turnoverMax"),
    enableVolumeRatio: checked("enableVolumeRatio"),
    volumeRatioMin: value("volumeRatioMin"),
    volumeRatioMax,
    enableCircMv: checked("enableCircMv"),
    circMvMin: value("circMvMin"),
    circMvMax: value("circMvMax"),
    enableProfitable: checked("enableProfitable"),
    enableMainInflow: checked("enableMainInflow"),
    enableHotBoard: checked("enableHotBoard"),
    hotBoardTopN: Math.max(1, value("hotBoardTopN") || 1),
    enableLimitUp: checked("enableLimitUp"),
    limitUpLookback: Math.max(1, value("limitUpLookback") || 1),
    enableVolumeStair: checked("enableVolumeStair"),
    volumeStairDays: Math.max(2, value("volumeStairDays") || 2),
    enableMaBullish: checked("enableMaBullish"),
    enableMa5Bias: checked("enableMa5Bias"),
    maxMa5Bias: Math.max(0, value("maxMa5Bias") || 0) / 100,
    enablePlatform: checked("enablePlatform"),
    platformLookback: Math.max(1, value("platformLookback") || 1),
    enableNearHigh: checked("enableNearHigh"),
    near20dHigh: Math.max(0.01, Math.min(1, (value("near20dHigh") || 97) / 100)),
    enableVwap: checked("enableVwap"),
    aboveVwapRatio: Math.max(0.01, Math.min(1, (value("aboveVwapRatio") || 100) / 100)),
    skipOpenMinutes: Math.max(0, value("skipOpenMinutes") || 0),
    enableStrongerThanIndex: checked("enableStrongerThanIndex"),
    enableTailHigh: checked("enableTailHigh"),
    enableRapidRise: checked("enableRapidRise"),
    rapidWindow: Math.max(1, value("rapidWindow") || 1),
    rapidPct: Math.max(0, value("rapidPct") || 0),
    rapidVolume: Math.max(0, value("rapidVolume") || 0),
    monitorInterval: Math.max(1, value("monitorInterval") || 1)
  };
  if (options.pctMin > options.pctMax) throw new Error("涨幅最小值不能大于最大值");
  if (options.turnoverMin > options.turnoverMax) throw new Error("换手率最小值不能大于最大值");
  if (options.volumeRatioMax != null && options.volumeRatioMin > options.volumeRatioMax) {
    throw new Error("量比最小值不能大于最大值");
  }
  if (options.circMvMin > options.circMvMax) throw new Error("流通市值最小值不能大于最大值");
  return options;
}

function clearLog() {
  document.querySelector("#log").textContent = "";
}

function logMessage(message) {
  const log = document.querySelector("#log");
  const lines = `${log.textContent}\n${message}`.split("\n").filter(Boolean).slice(-80);
  log.textContent = lines.join("\n");
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
  const body = rows.map((row) =>
    `<tr>${columns.map((column) => `<td>${escapeHtml(row[column])}</td>`).join("")}</tr>`
  ).join("");
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
    clearLog();
    renderResults([]);
    document.querySelector("#screenButton").textContent = "停止选股";
    setStatus("正在选股...");
    const result = await runScreen(false, state.screen, () => {});
    state.screenRows = result;
    renderResults(result);
    if (!state.screen.stopped) {
      setStatus(`选股完成：${result.length} 只`);
    }
  } catch (error) {
    if (!state.screen?.stopped) {
      logMessage(`选股失败：${error.message}`);
      setStatus(`选股失败：${error.message}`);
    }
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
  clearLog();
  document.querySelector("#monitorButton").textContent = "停止监控";
  setStatus("正在实时监控...");
  try {
    while (!state.monitor.stopped) {
      logMessage(`---- 监控刷新 ${new Date().toLocaleTimeString()} ----`);
      const result = await runScreen(true, state.monitor, () => {});
      state.screenRows = result;
      renderResults(result);
      setStatus(`实时监控中：当前 ${result.length} 只`);
      await new Promise((resolve) => setTimeout(resolve, readOptions().monitorInterval * 1000));
    }
  } catch (error) {
    if (!state.monitor.stopped) {
      logMessage(`监控失败：${error.message}`);
      setStatus(`监控失败：${error.message}`);
    }
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
    if (!state.similar.stopped) {
      setStatus(`相似分析完成：${result.length} 条`);
      logMessage(`相似分析完成：${result.length} 条`);
    }
  } catch (error) {
    if (!state.similar?.stopped) {
      logMessage(`相似分析失败：${error.message}`);
      setStatus(`相似分析失败：${error.message}`);
    }
  } finally {
    state.similar = null;
    document.querySelector("#similarButton").textContent = "开始分析";
  }
}

document.querySelector("#screenButton").addEventListener("click", startScreen);
document.querySelector("#monitorButton").addEventListener("click", toggleMonitor);
document.querySelector("#similarButton").addEventListener("click", startSimilarity);
document.querySelector("#exportButton").addEventListener("click", saveResult);
