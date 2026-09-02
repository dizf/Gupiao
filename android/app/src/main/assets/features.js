(() => {
  const API_FEATURE = {
    news: "https://np-listapi.eastmoney.com/nlist/api/list/get",
    quote: "https://push2.eastmoney.com/api/qt/stock/get",
    ulist: "https://push2.eastmoney.com/api/qt/ulist.np/get"
  };

  const US_ETF_MAP = [
    [/半导体|芯片|集成电路|电子|计算机|软件|通信|互联网|人工智能|AI|消费电子/i, ["107.XLK", "107.XLC"]],
    [/银行|证券|保险|金融|多元金融/i, ["107.XLF"]],
    [/石油|煤炭|天然气|油气|能源/i, ["107.XLE"]],
    [/有色|金属|钢铁|化工|材料|稀土|锂|铝|铜/i, ["107.XLB"]],
    [/汽车|家电|零售|旅游|酒店|餐饮|食品|饮料|白酒|纺织|服装|传媒|游戏/i, ["107.XLY", "107.XLP"]],
    [/医药|医疗|生物|制药|医疗器械/i, ["107.XLV"]],
    [/电力|公用事业|水务|燃气/i, ["107.XLU"]],
    [/房地产|地产|建筑|建材|园林/i, ["107.XLRE"]],
    [/机械|军工|航空|航天|工业|设备|工程/i, ["107.XLI"]]
  ];

  const state = {
    newsLoadedAt: 0,
    industryCache: new Map(),
    leaderCache: new Map(),
    usCache: new Map()
  };

  const $ = (id) => document.querySelector(id);
  const log = (message) => typeof window.logMessage === "function" && window.logMessage(message);
  const num = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;

  function buildUrl(url, params) {
    return `${url}?${new URLSearchParams(params).toString()}`;
  }

  async function request(url, params, tokenValue) {
    if (typeof window.getJson === "function") return window.getJson(url, params, tokenValue);
    const response = await fetch(buildUrl(url, params));
    if (!response.ok) throw new Error(`网络请求失败：${response.status}`);
    return response.json();
  }

  function installAccordionFix() {
    document.querySelectorAll("details.section > summary").forEach((summary) => {
      if (summary.dataset.accordionFixed) return;
      summary.dataset.accordionFixed = "1";
      summary.addEventListener("click", (event) => {
        event.preventDefault();
        const detail = summary.parentElement;
        detail.open = !detail.open;
      }, { passive: false });
    });
  }

  function injectUi() {
    const tech = [...document.querySelectorAll("details.section")].find((el) => el.textContent.includes("技术形态"));
    if (tech && !$("#enableUsSector")) {
      const content = tech.querySelector(".content");
      const title = document.createElement("div");
      title.className = "section-title";
      title.textContent = "隔夜外部市场";
      const us = document.createElement("label");
      us.className = "check";
      us.innerHTML = '<input id="enableUsSector" type="checkbox" checked>美股相关行业隔夜上涨';
      const usHelp = document.createElement("div");
      usHelp.className = "help";
      usHelp.textContent = "按个股所属东财行业匹配美股行业 ETF；只在能明确匹配时过滤，数据不可用时不误杀候选。";
      const leader = document.createElement("label");
      leader.className = "check";
      leader.innerHTML = '<input id="enableIndustryTop5" type="checkbox" checked>仅查找行业龙头前五名';
      const leaderHelp = document.createElement("div");
      leaderHelp.className = "help";
      leaderHelp.textContent = "行业内按当前流通市值排序，保留前 5 名；行业信息暂时不可用时保留股票并在日志提示。";
      content.append(title, us, usHelp, leader, leaderHelp);
    }

    if (!$("#newsSection")) {
      const section = document.createElement("details");
      section.id = "newsSection";
      section.className = "section";
      section.open = true;
      section.innerHTML = `
        <summary>③ 隔夜新闻 <span class="summary-note">最新快讯 · 关键词提示</span></summary>
        <div class="content">
          <div class="help">默认查看上一交易日收盘后至今天早盘的最新快讯。标签只是关键词辅助，不代表确定的利好或利空。</div>
          <div class="actions"><button id="refreshNewsButton">刷新隔夜新闻</button><button id="newsAllButton" class="secondary">查看全部</button></div>
          <div id="newsStatus" class="hint">等待加载…</div>
          <div id="newsList" class="result-cards"><div class="empty">暂无新闻</div></div>
        </div>`;
      const anchor = [...document.querySelectorAll("details.section")].find((el) => el.textContent.includes("T+1 次日开盘回测"));
      (anchor?.parentElement || document.body).insertBefore(section, anchor || null);
    }
    installAccordionFix();
  }

  function overnightRange() {
    const now = new Date();
    const start = new Date(now);
    start.setDate(start.getDate() - 1);
    start.setHours(17, 30, 0, 0);
    const end = new Date(now);
    end.setHours(9, 35, 0, 0);
    return { start, end };
  }

  function parseNews(payload) {
    const root = payload?.data || payload?.result || payload || {};
    const raw = root.list || root.data || root.items || root.news || root.rows || [];
    const rows = Array.isArray(raw) ? raw : Object.values(raw || {});
    return rows.map((item) => {
      const title = String(item.title || item.cmsTitle || item.content || item.text || item.NewsTitle || "").replace(/<[^>]+>/g, "").trim();
      const time = String(item.showTime || item.publishTime || item.time || item.ctime || item.datetime || item.NewsTime || "");
      const content = String(item.digest || item.summary || item.content || item.text || "").replace(/<[^>]+>/g, "").trim();
      const url = String(item.url || item.newsUrl || item.link || item.NewsUrl || "");
      return { title, time, content, url };
    }).filter((item) => item.title);
  }

  function parseTime(value) {
    if (!value) return null;
    const text = value.replace(/-/g, "/");
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function newsTag(text) {
    const good = /增持|回购|中标|签约|获批|突破|增长|上调|盈利|订单|扩产|创新高|利好|重大进展|获奖|并购/i;
    const bad = /减持|亏损|下调|处罚|诉讼|调查|风险|暴跌|下修|违约|暂停|终止|利空/i;
    if (good.test(text)) return "可能利好";
    if (bad.test(text)) return "风险提示";
    return "待判断";
  }

  function renderNews(rows, all = false) {
    const list = $("#newsList");
    if (!list) return;
    const visible = all ? rows : rows.slice(0, 20);
    if (!visible.length) {
      list.innerHTML = '<div class="empty">当前时段没有抓到可解析的快讯。</div>';
      return;
    }
    list.innerHTML = visible.map((item) => {
      const tag = newsTag(`${item.title} ${item.content}`);
      const tagClass = tag === "可能利好" ? "ok" : tag === "风险提示" ? "warn" : "info";
      const href = item.url && /^https?:/i.test(item.url)
        ? `<a href="${item.url.replace(/"/g, "&quot;")}" target="_blank" rel="noopener">查看原文</a>` : "";
      return `<article class="result-card"><div class="result-card-title">${escapeHtml(item.title)}</div><div class="chiprow"><span class="chip ${tagClass}">${tag}</span><span class="chip">${escapeHtml(item.time || "时间未知")}</span></div><div class="hint">${escapeHtml(item.content || "无摘要")}</div><div class="hint">${href}</div></article>`;
    }).join("");
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }

  let newsRows = [];
  async function loadNews(showAll = false) {
    const status = $("#newsStatus");
    if (status) status.textContent = "正在拉取 7×24 快讯…";
    try {
      const { start, end } = overnightRange();
      const payload = await request(API_FEATURE.news, {
        client: "web",
        column_id: 102,
        limit: 80,
        last_time: Math.floor(Date.now() / 1000)
      });
      const parsed = parseNews(payload);
      newsRows = parsed.filter((item) => {
        const date = parseTime(item.time);
        if (!date) return true;
        return date >= start && date <= end;
      }).sort((a, b) => (parseTime(b.time)?.getTime() || 0) - (parseTime(a.time)?.getTime() || 0));
      if (status) status.textContent = `隔夜时段抓到 ${newsRows.length} 条，显示 ${showAll ? newsRows.length : Math.min(newsRows.length, 20)} 条`;
      renderNews(newsRows, showAll);
      state.newsLoadedAt = Date.now();
    } catch (error) {
      if (status) status.textContent = `新闻获取失败：${error.message}`;
      renderNews([], false);
    }
  }

  function installNewsEvents() {
    $("#refreshNewsButton")?.addEventListener("click", () => loadNews(false));
    $("#newsAllButton")?.addEventListener("click", () => renderNews(newsRows, true));
  }

  function readFeatureOptions() {
    const original = window.readOptions;
    if (original && !original.__featureWrapped) {
      const wrapped = function () {
        const options = original();
        return {
          ...options,
          enableUsSector: $("#enableUsSector")?.checked !== false,
          enableIndustryTop5: $("#enableIndustryTop5")?.checked !== false
        };
      };
      wrapped.__featureWrapped = true;
      window.readOptions = wrapped;
    }
  }

  async function fetchIndustry(code, tokenValue) {
    if (state.industryCache.has(code)) return state.industryCache.get(code);
    const promise = request(API_FEATURE.quote, {
      secid: /^[69]/.test(code) ? `1.${code}` : `0.${code}`,
      fields: "f57,f58,f116,f117,f127,f128",
      ut: "bd1d9ddb04089700cf9c27f6f7426281"
    }, tokenValue).then((payload) => {
      const data = payload?.data || {};
      return {
        name: String(data.f127 || "").trim(),
        industryCode: String(data.f128 || "").trim(),
        floatMarketValue: num(data.f117 || data.f116)
      };
    }).catch(() => ({ name: "", industryCode: "", floatMarketValue: 0 }));
    state.industryCache.set(code, promise);
    return promise;
  }

  async function isIndustryTop5(row, tokenValue) {
    const info = await fetchIndustry(row.code, tokenValue);
    if (!info.industryCode) return { pass: true, reason: "行业信息不可用" };
    if (state.leaderCache.has(info.industryCode)) {
      const leaders = await state.leaderCache.get(info.industryCode);
      return { pass: leaders.has(row.code), industry: info.name };
    }
    const promise = request("https://push2.eastmoney.com/api/qt/clist/get", {
      pn: 1, pz: 100, po: 1, np: 1, fltt: 2, invt: 2, fid: "f21",
      fs: `b:${info.industryCode}+f:!50`,
      fields: "f12,f14,f21,f2,f3"
    }, tokenValue).then((payload) => {
      const rows = Array.isArray(payload?.data?.diff) ? payload.data.diff : Object.values(payload?.data?.diff || {});
      return new Set(rows.sort((a, b) => num(b.f21) - num(a.f21)).slice(0, 5).map((item) => String(item.f12 || "").padStart(6, "0")));
    }).catch(() => new Set());
    state.leaderCache.set(info.industryCode, promise);
    const leaders = await promise;
    return { pass: leaders.size ? leaders.has(row.code) : true, industry: info.name, unavailable: !leaders.size };
  }

  function relatedEtfs(industry) {
    for (const [pattern, tickers] of US_ETF_MAP) if (pattern.test(industry || "")) return tickers;
    return [];
  }

  async function usEtfUp(tickers, tokenValue) {
    if (!tickers.length) return { pass: true, unavailable: true, reason: "未找到对应美股行业" };
    const key = tickers.join(",");
    if (state.usCache.has(key)) return state.usCache.get(key);
    const promise = request(API_FEATURE.ulist, {
      secids: tickers.join(","),
      fields: "f2,f3,f12,f14,f43,f60",
      ut: "bd1d9ddb04089700cf9c27f6f7426281"
    }, tokenValue).then((payload) => {
      const rows = Array.isArray(payload?.data?.diff) ? payload.data.diff : Object.values(payload?.data?.diff || {});
      const valid = rows.filter((item) => num(item.f2) > 0);
      if (!valid.length) return { pass: true, unavailable: true, reason: "美股行业数据不可用" };
      return {
        pass: valid.every((item) => num(item.f3) > 0),
        unavailable: false,
        detail: valid.map((item) => `${item.f14 || item.f12} ${num(item.f3).toFixed(2)}%`).join(" / ")
      };
    }).catch(() => ({ pass: true, unavailable: true, reason: "美股行业数据获取失败" }));
    state.usCache.set(key, promise);
    return promise;
  }

  const originalAnalyze = window.analyzeStock;
  if (originalAnalyze && !originalAnalyze.__featureWrapped) {
    const wrappedAnalyze = async function (row, options, tokenValue) {
      if (options.enableIndustryTop5) {
        const leader = await isIndustryTop5(row, tokenValue);
        if (!leader.pass) {
          log(`   排除 ${row.code} ${row.name}：不在${leader.industry || "所属行业"}流通市值前5`);
          return null;
        }
        if (leader.reason) log(`   ${row.code} ${row.name}：${leader.reason}，保留`);
      }
      if (options.enableUsSector) {
        const info = await fetchIndustry(row.code, tokenValue);
        const tickers = relatedEtfs(info.name);
        const us = await usEtfUp(tickers, tokenValue);
        if (!us.pass) {
          log(`   排除 ${row.code} ${row.name}：对应美股行业隔夜未全部上涨（${us.detail || us.reason || ""}）`);
          return null;
        }
        if (us.unavailable) log(`   ${row.code} ${row.name}：${us.reason || "美股行业未匹配"}，保留`);
      }
      return originalAnalyze(row, options, tokenValue);
    };
    wrappedAnalyze.__featureWrapped = true;
    window.analyzeStock = wrappedAnalyze;
  }

  injectUi();
  readFeatureOptions();
  installNewsEvents();
  loadNews(false);
})();
