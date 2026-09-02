(() => {
  const API_FEATURE = {
    // 东财网页端 7x24 快讯接口
    news: "https://np-weblist.eastmoney.com/comm/web/getFastNewsList",
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
    usCache: new Map(),
    newsPageOpen: false,
    newsDetailOpen: false,
    ignoreNextPop: false
  };

  const $ = (id) => document.querySelector(id);
  const log = (message) => typeof window.logMessage === "function" && window.logMessage(message);
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

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

    if (!$("#newsFeatureStyle")) {
      const style = document.createElement("style");
      style.id = "newsFeatureStyle";
      style.textContent = `
        .news-entry{display:flex;align-items:center;gap:10px;width:100%;border:0;background:transparent;padding:0;text-align:left;color:inherit}
        .news-entry-main{flex:1;min-width:0}
        .news-entry-title{font-size:15px;font-weight:750;color:#1e3a8a}
        .news-entry-sub{font-size:11px;color:#667085;margin-top:4px;line-height:1.45}
        .news-entry-arrow{color:#94a3b8;font-size:18px;flex:0 0 auto}
        .news-page{position:fixed;inset:0;z-index:70;display:none;flex-direction:column;background:#f4f7fb}
        .news-page.open{display:flex}
        .news-page-header{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:8px;padding:10px 12px;background:rgba(244,247,251,.96);border-bottom:1px solid #e3e8f1}
        .news-back{min-height:36px;padding:6px 12px;border:1px solid #d6deea;border-radius:10px;background:#fff;color:#334155;font-weight:650}
        .news-page-title{flex:1;min-width:0;font-size:15px;font-weight:750;color:#1e3a8a}
        .news-page-body{flex:1;overflow:auto;-webkit-overflow-scrolling:touch;padding:12px}
        .news-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
        .news-tab{border:1px solid #d0d7e2;background:#fff;color:#344054;border-radius:999px;padding:6px 12px;font-size:12px;min-height:32px}
        .news-tab.active{background:#1d4ed8;border-color:#1d4ed8;color:#fff}
        .news-card{cursor:pointer}
        .news-modal{position:fixed;inset:0;z-index:90;display:none;align-items:flex-end;justify-content:center;background:rgba(15,23,42,.45);padding:16px}
        .news-modal.open{display:flex}
        .news-modal-card{width:min(640px,100%);max-height:78vh;overflow:auto;background:#fff;border-radius:18px;padding:16px;box-shadow:0 18px 40px rgba(15,23,42,.28)}
        .news-modal-title{font-size:16px;font-weight:700;line-height:1.45;margin:8px 0}
        .news-modal-body{white-space:pre-wrap;font-size:13px;line-height:1.6;color:#334155}
        .news-modal-actions{display:flex;gap:8px;margin-top:14px}
        body.news-lock{overflow:hidden}
      `;
      document.head.appendChild(style);
    }

    if (!$("#newsEntrySection")) {
      const section = document.createElement("div");
      section.id = "newsEntrySection";
      section.className = "section";
      section.style.padding = "14px";
      section.innerHTML = `
        <button type="button" id="openNewsPageButton" class="news-entry">
          <span class="news-entry-main">
            <span class="news-entry-title">近期新闻</span>
            <span id="newsEntryHint" class="news-entry-sub">近12小时快讯</span>
          </span>
          <span class="news-entry-arrow">›</span>
        </button>`;
      const anchor = [...document.querySelectorAll("details.section")].find((el) => el.textContent.includes("T+1 次日开盘回测"));
      (anchor?.parentElement || document.body).insertBefore(section, anchor || null);
    }

    if (!$("#newsPage")) {
      const page = document.createElement("div");
      page.id = "newsPage";
      page.className = "news-page";
      page.innerHTML = `
        <div class="news-page-header">
          <button type="button" id="newsBackButton" class="news-back">← 返回</button>
          <div class="news-page-title">近12小时新闻</div>
          <button type="button" id="refreshNewsButton" class="news-back">刷新</button>
        </div>
        <div class="news-page-body">
          <div class="help">标签只是关键词辅助，不代表确定的利好或利空。点击条目可查看详情；可点返回，或从左缘右滑返回。</div>
          <div id="newsStatus" class="hint">等待加载…</div>
          <div id="newsTabs" class="news-tabs"></div>
          <div id="newsList" class="result-cards"><div class="empty">暂无新闻</div></div>
        </div>`;
      document.body.appendChild(page);
    }

    if (!$("#newsModal")) {
      const modal = document.createElement("div");
      modal.id = "newsModal";
      modal.className = "news-modal";
      modal.innerHTML = `
        <div class="news-modal-card" role="dialog" aria-modal="true">
          <div class="chiprow"><span id="newsModalTag" class="chip info">待判断</span><span id="newsModalTime" class="chip">时间未知</span></div>
          <div id="newsModalTitle" class="news-modal-title"></div>
          <div id="newsModalBody" class="news-modal-body"></div>
          <div class="news-modal-actions">
            <button id="newsModalOpen" type="button">打开原文</button>
            <button id="newsModalClose" class="secondary" type="button">关闭</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
    }
    installAccordionFix();
  }

  function recentNewsRange(hours = 12) {
    const end = new Date();
    const start = new Date(end.getTime() - Math.max(1, hours) * 60 * 60 * 1000);
    return { start, end };
  }

  function parseNewsItem(item) {
    const code = String(item.code || item.realSort || "");
    const title = String(item.title || item.cmsTitle || item.NewsTitle || "").replace(/<[^>]+>/g, "").trim();
    const time = String(item.showTime || item.publishTime || item.time || item.ctime || item.datetime || item.NewsTime || "");
    const content = String(item.summary || item.digest || item.content || item.text || "").replace(/<[^>]+>/g, "").trim();
    const url = String(item.url || item.newsUrl || item.link || item.NewsUrl || "");
    return { code, title, time, content, url, tag: newsTag(`${title} ${content}`) };
  }

  function parseTime(value) {
    if (!value) return null;
    const text = String(value).replace("T", " ").replace(/-/g, "/").trim().slice(0, 19);
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

  const NEWS_CATEGORIES = ["全部", "可能利好", "风险提示", "待判断"];
  let newsRows = [];
  let newsCategory = "全部";
  let newsModalLink = "";

  function newsGroups(rows) {
    const groups = { 全部: [...rows], 可能利好: [], 风险提示: [], 待判断: [] };
    for (const item of rows) {
      const tag = NEWS_CATEGORIES.includes(item.tag) ? item.tag : "待判断";
      groups[tag].push(item);
    }
    return groups;
  }

  function updateEntryHint(rows) {
    const hint = $("#newsEntryHint");
    if (!hint) return;
    if (!rows.length) {
      hint.textContent = "近12小时快讯";
      return;
    }
    const groups = newsGroups(rows);
    hint.textContent = `近12小时 ${rows.length} 条｜利好 ${groups["可能利好"].length}｜风险 ${groups["风险提示"].length}`;
  }

  function renderNewsTabs(rows) {
    const tabs = $("#newsTabs");
    if (!tabs) return;
    const groups = newsGroups(rows);
    tabs.innerHTML = NEWS_CATEGORIES.map((category) => {
      const count = category === "全部" ? rows.length : groups[category].length;
      const active = category === newsCategory ? " active" : "";
      return `<button type="button" class="news-tab${active}" data-news-category="${category}">${category} (${count})</button>`;
    }).join("");
  }

  function renderNews(rows) {
    const list = $("#newsList");
    if (!list) return;
    const groups = newsGroups(rows);
    const visible = newsCategory === "全部" ? rows : groups[newsCategory] || [];
    renderNewsTabs(rows);
    updateEntryHint(rows);
    if (!visible.length) {
      list.innerHTML = '<div class="empty">近12小时没有抓到可解析的快讯。</div>';
      return;
    }
    list.innerHTML = visible.map((item, index) => {
      const tagClass = item.tag === "可能利好" ? "ok" : item.tag === "风险提示" ? "warn" : "info";
      return `<article class="result-card news-card" data-news-index="${index}" data-news-tag="${escapeHtml(item.tag)}"><div class="result-card-title">${escapeHtml(item.title)}</div><div class="chiprow"><span class="chip ${tagClass}">${escapeHtml(item.tag)}</span><span class="chip">${escapeHtml(item.time || "时间未知")}</span></div><div class="hint">${escapeHtml(item.content || "无摘要")}</div></article>`;
    }).join("");
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[c]));
  }

  function openNewsDetail(item) {
    const modal = $("#newsModal");
    if (!modal || !item) return;
    const tag = item.tag || "待判断";
    const tagEl = $("#newsModalTag");
    tagEl.textContent = tag;
    tagEl.className = `chip ${tag === "可能利好" ? "ok" : tag === "风险提示" ? "warn" : "info"}`;
    $("#newsModalTime").textContent = item.time || "时间未知";
    $("#newsModalTitle").textContent = item.title || "";
    $("#newsModalBody").textContent = item.content || "暂无摘要";
    newsModalLink = item.url || "";
    $("#newsModalOpen").disabled = !/^https?:/i.test(newsModalLink);
    modal.classList.add("open");
    state.newsDetailOpen = true;
  }

  function closeNewsDetail() {
    $("#newsModal")?.classList.remove("open");
    state.newsDetailOpen = false;
  }

  function openNewsPage() {
    const page = $("#newsPage");
    if (!page) return;
    page.classList.add("open");
    document.body.classList.add("news-lock");
    if (!state.newsPageOpen) {
      state.newsPageOpen = true;
      history.pushState({ newsPage: true }, "", "#news");
    }
    if (!newsRows.length || Date.now() - state.newsLoadedAt > 5 * 60 * 1000) {
      loadNews();
    } else {
      renderNews(newsRows);
    }
  }

  function closeNewsPage(fromPopstate = false) {
    closeNewsDetail();
    const page = $("#newsPage");
    page?.classList.remove("open");
    document.body.classList.remove("news-lock");
    if (!state.newsPageOpen) return;
    state.newsPageOpen = false;
    if (!fromPopstate && history.state && history.state.newsPage) {
      state.ignoreNextPop = true;
      history.back();
    }
  }

  function handleAppBack() {
    if (state.newsDetailOpen) {
      closeNewsDetail();
      return true;
    }
    if (state.newsPageOpen) {
      closeNewsPage(false);
      return true;
    }
    return false;
  }

  window.__appBack = handleAppBack;

  async function fetchRecentNews(limit = 120, hours = 12) {
    const { start, end } = recentNewsRange(hours);
    const pageSize = 80;
    const maxPages = 20;
    let sortEnd = "";
    const seen = new Set();
    const rows = [];
    let reachedStart = false;

    for (let page = 0; page < maxPages; page += 1) {
      const payload = await request(API_FEATURE.news, {
        client: "web",
        biz: "web_724",
        fastColumn: "102",
        sortEnd,
        pageSize: String(pageSize),
        req_trace: String(Date.now())
      });
      const data = payload?.data || {};
      const list = data.fastNewsList || data.list || data.items || [];
      const raw = Array.isArray(list) ? list : Object.values(list || {});
      if (!raw.length) break;

      let oldestInPage = null;
      for (const item of raw) {
        const parsed = parseNewsItem(item);
        if (!parsed.title) continue;
        if (parsed.code) {
          if (seen.has(parsed.code)) continue;
          seen.add(parsed.code);
        }
        const date = parseTime(parsed.time);
        if (date) {
          oldestInPage = oldestInPage == null || date < oldestInPage ? date : oldestInPage;
          if (date > end) continue;
          if (date < start) {
            reachedStart = true;
            continue;
          }
        }
        rows.push(parsed);
      }

      const nextSort = String(data.sortEnd || "");
      if (!nextSort || nextSort === sortEnd) break;
      sortEnd = nextSort;
      if (reachedStart) break;
      if (oldestInPage && oldestInPage < start) break;
    }

    rows.sort((a, b) => (parseTime(b.time)?.getTime() || 0) - (parseTime(a.time)?.getTime() || 0));
    return rows.slice(0, limit);
  }

  async function loadNews() {
    const status = $("#newsStatus");
    if (status) status.textContent = "正在拉取近12小时快讯…";
    log("新闻：开始请求东方财富近12小时快讯…");
    try {
      newsRows = await fetchRecentNews(120, 12);
      const groups = newsGroups(newsRows);
      if (status) {
        status.textContent = newsRows.length
          ? `近12小时共 ${newsRows.length} 条｜可能利好 ${groups["可能利好"].length}｜风险提示 ${groups["风险提示"].length}｜待判断 ${groups["待判断"].length}`
          : "近12小时暂无快讯";
      }
      renderNews(newsRows);
      state.newsLoadedAt = Date.now();
      log(`新闻：近12小时保留 ${newsRows.length} 条。`);
    } catch (error) {
      if (status) status.textContent = `新闻获取失败：${error.message}`;
      newsRows = [];
      renderNews([]);
      log(`新闻获取失败：${error.message}`);
    }
  }

  function installSwipeBack() {
    const page = $("#newsPage");
    if (!page || page.dataset.swipeReady) return;
    page.dataset.swipeReady = "1";
    let startX = 0;
    let startY = 0;
    let tracking = false;
    page.addEventListener("touchstart", (event) => {
      if (!state.newsPageOpen || !event.touches.length) return;
      const touch = event.touches[0];
      if (touch.clientX > 28) return;
      startX = touch.clientX;
      startY = touch.clientY;
      tracking = true;
    }, { passive: true });
    page.addEventListener("touchend", (event) => {
      if (!tracking) return;
      tracking = false;
      const touch = event.changedTouches[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = Math.abs(touch.clientY - startY);
      if (dx > 80 && dy < 60) handleAppBack();
    }, { passive: true });
  }

  function installNewsEvents() {
    $("#openNewsPageButton")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openNewsPage();
    });
    $("#newsBackButton")?.addEventListener("click", () => closeNewsPage(false));
    $("#refreshNewsButton")?.addEventListener("click", () => loadNews());
    $("#newsTabs")?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-news-category]");
      if (!button) return;
      newsCategory = button.getAttribute("data-news-category") || "全部";
      renderNews(newsRows);
    });
    $("#newsList")?.addEventListener("click", (event) => {
      const card = event.target.closest(".news-card");
      if (!card) return;
      const groups = newsGroups(newsRows);
      const visible = newsCategory === "全部" ? newsRows : groups[newsCategory] || [];
      const item = visible[Number(card.getAttribute("data-news-index"))];
      if (item) openNewsDetail(item);
    });
    $("#newsModalClose")?.addEventListener("click", closeNewsDetail);
    $("#newsModal")?.addEventListener("click", (event) => {
      if (event.target.id === "newsModal") closeNewsDetail();
    });
    $("#newsModalOpen")?.addEventListener("click", () => {
      if (!/^https?:/i.test(newsModalLink)) return;
      window.open(newsModalLink, "_blank", "noopener");
    });
    window.addEventListener("popstate", () => {
      if (state.ignoreNextPop) {
        state.ignoreNextPop = false;
        return;
      }
      if (state.newsDetailOpen) {
        closeNewsDetail();
        if (state.newsPageOpen) history.pushState({ newsPage: true }, "", "#news");
        return;
      }
      if (state.newsPageOpen) closeNewsPage(true);
    });
    installSwipeBack();
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
  // 预取摘要，不自动打开二级页
  loadNews();
})();
