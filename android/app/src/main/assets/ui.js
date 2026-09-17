(() => {
  const $ = (id) => document.querySelector(id);
  const screenBtn = $("#screenButton");
  const monitorBtn = $("#monitorButton");
  const similarBtn = $("#similarButton");
  const backtestBtn = $("#backtestButton");
  const cancelBtn = $("#cancelButton");
  const status = $("#status");
  const dot = $("#statusDot");
  const log = $("#log");
  const results = $("#results");
  const resultBadge = $("#resultBadge");
  const LOG_STORAGE_KEY = "gupiao_runtime_log_v1";

  function taskButtons() { return [screenBtn, monitorBtn, similarBtn, backtestBtn, $("#gapOneButton"), $("#gapScanButton")].filter(Boolean); }
  function runningButton(btn) { return /停止/.test(btn?.textContent || ""); }

  function stopAll() {
    const running = taskButtons().filter(runningButton);
    running.forEach((btn) => btn.click());
    if (!running.length && typeof stopToken === "function") {
      if (window.__backtestToken) stopToken(window.__backtestToken);
      if (window.__gapToken) stopToken(window.__gapToken);
      if (window.__gapScanToken) stopToken(window.__gapScanToken);
    }
    setTimeout(refreshState, 80);
  }

  function refreshState() {
    const running = taskButtons().some(runningButton);
    if (cancelBtn) cancelBtn.classList.toggle("show", running);
    taskButtons().forEach((btn) => {
      const active = runningButton(btn);
      btn.classList.toggle("running", active);
      btn.setAttribute("aria-busy", active ? "true" : "false");
    });
  }

  function decorateStatus() {
    if (!status || !dot) return;
    const text = status.textContent || "";
    const running = /正在|分析中|监控中|回测中|扫描/.test(text);
    const error = /失败|错误/.test(text);
    dot.className = `dot ${running ? "running" : error ? "error" : /完成|停止|就绪|已保存/.test(text) ? "success" : ""}`;
    refreshState();
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }

  function persistLog() {
    if (!log) return;
    try {
      const text = log.textContent || "";
      if (text.trim()) localStorage.setItem(LOG_STORAGE_KEY, text);
      else localStorage.removeItem(LOG_STORAGE_KEY);
    } catch (_) {}
  }

  function restoreLog() {
    if (!log) return;
    try {
      const saved = localStorage.getItem(LOG_STORAGE_KEY);
      if (saved && saved.trim()) log.textContent = saved;
    } catch (_) {}
  }

  function copyRuntimeLog(button) {
    const text = log?.textContent?.trim() || "暂无运行日志";
    const done = () => {
      const old = button.textContent;
      button.textContent = "已复制日志";
      setTimeout(() => { button.textContent = old; }, 1200);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.focus();
    area.select();
    try { document.execCommand("copy"); done(); } catch (_) {}
    area.remove();
  }

  let renderingLog = false;
  let logObserver = null;
  function highlightLog() {
    if (!log || renderingLog) return;
    const text = log.textContent || "";
    const lines = text.split("\n").filter(Boolean).slice(-100);
    renderingLog = true;
    if (logObserver) logObserver.disconnect();
    try {
      log.innerHTML = lines.map((line, index) => {
        let cls = "info";
        if (/排除|关闭|没有|不足|停止/.test(line)) cls = "warn";
        if (/失败|错误/.test(line)) cls = "error";
        if (/完成|成功|剩余 \d+ 只|合计：|进度 \d+\/\d+/.test(line)) cls = "ok";
        if (index === lines.length - 1) cls += " latest";
        return `<div class="logline ${cls}">${escapeHtml(line)}</div>`;
      }).join("");
    } finally {
      renderingLog = false;
      if (logObserver) logObserver.observe(log, { childList: true, characterData: true, subtree: true });
    }
    log.scrollTop = log.scrollHeight;
    persistLog();
  }

  function updateResultBadge() {
    if (!resultBadge || !results) return;
    const cards = results.querySelectorAll(".result-card").length;
    const rows = results.querySelectorAll("tbody tr").length;
    resultBadge.textContent = `${Math.max(cards, rows)} 条`;
    const count = Math.max(cards, rows);
    const dashboardCount = $("#dashboardResultCount");
    if (dashboardCount) dashboardCount.textContent = count ? `${count} 只` : "待选";
  }

  function injectPremiumStyle() {
    if ($("#premiumDashboardStyle")) return;
    const style = document.createElement("style");
    style.id = "premiumDashboardStyle";
    style.textContent = `
      :root{--ink:#0f172a;--muted:#64748b;--line:#e6ebf2;--panel:#ffffff;--soft:#f5f7fb;--blue:#2563eb;--blue2:#4f46e5;--green:#059669;--orange:#f59e0b}
      body{background:linear-gradient(180deg,#eef4ff 0,#f6f8fc 220px,#f7f8fb 100%);padding:0 14px 34px;letter-spacing:.01em}
      .topbar{position:sticky;top:0;z-index:50;background:rgba(246,248,252,.9);backdrop-filter:blur(16px);padding:9px 0 8px}
      .statusbar{border:1px solid rgba(255,255,255,.9);background:rgba(255,255,255,.88);box-shadow:0 8px 24px rgba(30,64,175,.08);border-radius:16px;padding:9px 11px}
      .actions{grid-template-columns:minmax(0,1.35fr) minmax(0,.65fr);gap:9px;margin-top:9px}
      .actions button{min-height:48px;border-radius:14px;font-size:14px;box-shadow:0 8px 18px rgba(37,99,235,.18)}
      .actions button.secondary{background:#0f172a;box-shadow:0 8px 18px rgba(15,23,42,.13)}
      .quick{margin-top:7px}.quick button{min-height:34px;border:0;background:transparent;color:#64748b;font-size:11px}
      h1{font-size:28px;letter-spacing:-.04em;margin:18px 3px 2px;color:#0f172a;font-weight:850}
      .sub{font-size:12px;color:#64748b;margin:0 3px 13px}
      .premium-nav{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:4px 0 12px}
      .premium-nav button{border:1px solid rgba(255,255,255,.9);border-radius:13px;background:rgba(255,255,255,.82);min-height:52px;text-align:left;padding:8px 10px;color:#0f172a;box-shadow:0 7px 20px rgba(15,23,42,.06)}
      .premium-nav b{display:block;font-size:12px}.premium-nav span{display:block;font-size:9px;color:#94a3b8;margin-top:3px}
      .premium-nav .active{background:linear-gradient(135deg,#2563eb,#4f46e5);color:white;border-color:transparent;box-shadow:0 10px 22px rgba(37,99,235,.22)}
      .premium-nav .active span{color:#dbeafe}
      .dashboard-strip{display:grid;grid-template-columns:1.15fr 1fr 1fr;gap:8px;margin:0 0 12px}
      .dash-kpi{background:rgba(255,255,255,.88);border:1px solid rgba(255,255,255,.95);border-radius:15px;padding:11px 10px;box-shadow:0 7px 20px rgba(15,23,42,.05)}
      .dash-kpi .k{font-size:9px;color:#94a3b8}.dash-kpi .v{font-size:17px;font-weight:850;color:#0f172a;margin-top:3px}.dash-kpi .s{font-size:9px;color:#64748b;margin-top:2px}
      .section{border:1px solid rgba(226,232,240,.9);border-radius:18px;margin:10px 0;background:rgba(255,255,255,.94);box-shadow:0 8px 24px rgba(15,23,42,.055)}
      .section summary{padding:15px 15px;font-size:15px;color:#102a64}.section summary:after{font-size:17px}.content{padding:0 15px 16px}
      .feature-section{border-color:#dbe5ff;box-shadow:0 10px 28px rgba(37,99,235,.08)}
      .feature-section summary{font-size:16px}.feature-section .help{background:#f5f8ff}
      #newsSection{order:1}.backtest-hero{border-color:#cdd9ff;background:linear-gradient(145deg,#fff 0,#f5f8ff 100%)}
      .backtest-hero .summary-note{color:#4f46e5;font-weight:650}
      #resultsSection{border-color:#d8e5dc}.result-card{border-radius:13px;background:#fff}.result-card-title{color:#102a64}
      .chip{border-radius:999px;padding:5px 8px}.chip.ok{font-weight:700}
      .logbox{border-radius:14px;max-height:300px}
      .premium-caption{font-size:10px;color:#94a3b8;margin:-4px 2px 9px}
      @media(max-width:420px){body{padding-left:11px;padding-right:11px}.premium-nav{gap:6px}.premium-nav button{padding:8px 7px}.dashboard-strip{gap:6px}.dash-kpi{padding:10px 8px}.dash-kpi .v{font-size:15px}}
    `;
    document.head.appendChild(style);
  }

  function findSectionByText(text) {
    return [...document.querySelectorAll("details.section")].find((el) => el.textContent.includes(text));
  }

  function redesignDashboard() {
    if ($("#premiumNav")) return;
    injectPremiumStyle();
    const title = document.querySelector("body > h1");
    const sub = document.querySelector("body > .sub");
    if (title) title.textContent = "A股机会雷达";
    if (sub) sub.textContent = "今日选股 · 高开概率 · 近期新闻";

    const nav = document.createElement("div");
    nav.id = "premiumNav";
    nav.className = "premium-nav";
    nav.innerHTML = `
      <button data-target="screenArea" class="active"><b>选股</b><span>今日符合条件</span></button>
      <button data-target="gapArea"><b>高开概率</b><span>T+1 历史验证</span></button>
      <button data-target="newsArea"><b>近期新闻</b><span>隔夜 · 快讯</span></button>`;
    (sub?.parentNode || document.body).insertBefore(nav, sub?.nextSibling || null);

    const strip = document.createElement("div");
    strip.id = "dashboardStrip";
    strip.className = "dashboard-strip";
    strip.innerHTML = `
      <div class="dash-kpi"><div class="k">今日候选</div><div class="v" id="dashboardResultCount">待选</div><div class="s">基础 + 技术</div></div>
      <div class="dash-kpi"><div class="k">高开概率</div><div class="v" id="dashboardGapRate">—</div><div class="s">历史样本</div></div>
      <div class="dash-kpi"><div class="k">新闻</div><div class="v" id="dashboardNewsCount">—</div><div class="s">近期快讯</div></div>`;
    nav.parentNode.insertBefore(strip, nav.nextSibling);

    const basic = findSectionByText("基础筛选");
    const tech = findSectionByText("技术形态");
    const news = $("#newsSection") || findSectionByText("隔夜新闻");
    const backtest = findSectionByText("T+1 次日开盘回测");
    const similar = findSectionByText("相似走势分析");
    const logs = $("#logSection") || findSectionByText("运行日志");
    const result = $("#resultsSection") || findSectionByText("结果");

    if (basic) { basic.id = "screenArea"; basic.classList.add("feature-section"); }
    if (backtest) { backtest.id = "gapArea"; backtest.classList.add("feature-section", "backtest-hero"); }
    if (news) { news.id = "newsArea"; news.classList.add("feature-section"); }
    if (result) result.id = "resultsSection";

    // 把核心功能集中到页面前部；高级技术参数、相似走势和日志放后面。
    const anchor = strip.nextSibling;
    const parent = anchor?.parentNode;
    if (parent) {
      [result, news, backtest, basic, tech, similar, logs].filter(Boolean).forEach((el) => {
        parent.appendChild(el);
      });
    }

    if (basic) {
      const summary = basic.querySelector("summary");
      if (summary) summary.innerHTML = `① 今日选股 <span class="summary-note">基础条件 + 技术形态</span>`;
      const help = basic.querySelector(".help");
      if (help) help.textContent = "先确定今天的候选池。基础筛选控制价格、量能、资金和市值；技术形态用于进一步收敛。顶部“开始选股”会直接执行。";
    }
    if (tech) {
      const summary = tech.querySelector("summary");
      if (summary) summary.innerHTML = `技术形态 <span class="summary-note">趋势 · 强势 · 突破</span>`;
    }
    if (backtest) {
      const summary = backtest.querySelector("summary");
      if (summary) summary.innerHTML = `② 高开概率 <span class="summary-note">T+1 历史验证</span>`;
      const help = backtest.querySelector(".help");
      if (help) help.textContent = "这里计算的是历史条件下的次日高开率：找到过去与“今天条件”相似的交易日，再统计它们第二天的开盘表现。它是历史统计，不是对明天的保证。";
    }
    if (news) {
      const summary = news.querySelector("summary");
      if (summary) summary.innerHTML = `③ 近期新闻 <span class="summary-note">隔夜 · 7×24 快讯</span>`;
    }

    nav.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => {
        nav.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
        button.classList.add("active");
        const target = document.getElementById(button.dataset.target);
        if (target) {
          target.open = true;
          target.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      });
    });

    // 将“结果”放到核心区域后面，用户选股后可以直接看到。
    if (result) {
      const summary = result.querySelector("summary");
      if (summary) summary.innerHTML = `候选结果 <span class="summary-note">今日符合条件的股票</span><span id="resultBadge" class="badge">0 条</span>`;
    }
  }

  function updatePremiumKpis() {
    const gap = $("#dashboardGapRate");
    if (gap) {
      const source = document.querySelector("#backtestSummary");
      const text = source?.textContent || "";
      const m = text.match(/次日高开率[^0-9]*([0-9]+(?:\.[0-9]+)?%)/);
      if (m) gap.textContent = m[1];
    }
    const newsCount = $("#dashboardNewsCount");
    if (newsCount) {
      const statusText = $("#newsStatus")?.textContent || "";
      const m = statusText.match(/(?:抓到|显示|匹配)[^0-9]*([0-9]+)\s*条/);
      if (m) newsCount.textContent = `${m[1]} 条`;
    }
  }

  if (cancelBtn) cancelBtn.addEventListener("click", stopAll);
  const logButton = $("#scrollLogButton");
  if (logButton) logButton.addEventListener("click", () => {
    const section = $("#logSection");
    if (section) section.open = true;
    setTimeout(() => log?.scrollIntoView({ behavior: "smooth", block: "center" }), 30);
  });

  const logSection = $("#logSection");
  if (logSection && !$("#copyLogButton")) {
    const summary = logSection.querySelector("summary");
    if (summary) {
      const button = document.createElement("button");
      button.id = "copyLogButton";
      button.type = "button";
      button.textContent = "复制日志";
      button.style.cssText = "margin-left:auto;border:0;border-radius:8px;padding:5px 8px;background:#eef3ff;color:#3157a6;font-size:11px;font-weight:650";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        copyRuntimeLog(button);
      });
      summary.appendChild(button);
    }
  }

  const exportSimilar = $("#exportButton2");
  if (exportSimilar) exportSimilar.addEventListener("click", () => window.saveResult?.());

  restoreLog();
  redesignDashboard();
  if (status) new MutationObserver(decorateStatus).observe(status, { childList: true, characterData: true, subtree: true });
  if (log) {
    logObserver = new MutationObserver(() => {
      if (!renderingLog) highlightLog();
    });
    logObserver.observe(log, { childList: true, characterData: true, subtree: true });
  }
  if (results) new MutationObserver(() => { updateResultBadge(); updatePremiumKpis(); }).observe(results, { childList: true, subtree: true });
  setInterval(refreshState, 250);
  setInterval(updateResultBadge, 500);
  setInterval(updatePremiumKpis, 700);
  decorateStatus();
  highlightLog();
  updatePremiumKpis();
})();
