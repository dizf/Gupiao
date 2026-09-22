(() => {
  "use strict";

  function boot() {
    const $ = (s, root = document) => root.querySelector(s);
    const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
    const screen = $("#screenButton");
    if (!screen || $("#brokerStyle")) return;

    const findSection = (text) => $("details.section") && $$("details.section").find((el) => (el.textContent || "").includes(text));
    const basic = findSection("基础筛选");
    const tech = findSection("技术形态");
    const result = $("#resultsSection") || findSection("结果");
    const gap = findSection("T+1 次日开盘回测");
    const news = $("#newsSection") || findSection("隔夜新闻") || findSection("近期新闻");
    const similar = findSection("相似走势分析");
    const logs = $("#logSection") || findSection("运行日志");

    const style = document.createElement("style");
    style.id = "brokerStyle";
    style.textContent = `
      :root{--bg:#f4f6f9;--card:#fff;--ink:#172033;--muted:#8b95a5;--line:#e5e9ef;--navy:#142238;--gold:#c69a4c;--blue:#3569d5;--red:#df4a50;--green:#15946f}
      *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
      html{background:var(--bg);scroll-behavior:smooth}
      body{margin:0!important;padding:0 0 78px!important;max-width:none!important;background:var(--bg)!important;color:var(--ink)!important;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      body:before{content:"";display:block;height:env(safe-area-inset-top);background:var(--navy)}
      body>h1,body>.sub,.topbar{display:none!important}
      .broker-head{background:linear-gradient(180deg,#142238,#20324b);color:#fff;padding:15px 16px 17px;position:relative;overflow:hidden}
      .broker-head:after{content:"";position:absolute;width:220px;height:220px;border-radius:50%;right:-120px;top:-145px;background:rgba(198,154,76,.14)}
      .head-row{display:flex;justify-content:space-between;align-items:center;position:relative;z-index:1}
      .brand{font-size:21px;font-weight:850;letter-spacing:-.04em}.brand small{display:block;margin-top:3px;font-size:10px;font-weight:500;color:#afbac9;letter-spacing:0}
      .market-status{display:flex;align-items:center;gap:6px;max-width:145px;padding:6px 9px;border:1px solid rgba(255,255,255,.14);border-radius:99px;background:rgba(255,255,255,.08);font-size:10px;color:#dce3ed;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .market-dot{width:6px;height:6px;border-radius:50%;background:#62d5a6;flex:none}.market-dot.run{background:#f2bd62}.market-dot.err{background:#ff777b}
      .market-tape{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-top:15px;position:relative;z-index:1}.tape-item{padding:8px;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:rgba(255,255,255,.07)}.tape-item b{font-size:10px}.tape-item span{display:block;margin-top:3px;font-size:8px;color:#aeb9c8}
      .head-actions{display:grid;grid-template-columns:1.3fr .7fr;gap:8px;margin-top:12px;position:relative;z-index:1}.head-actions button{min-height:44px;border:0;border-radius:11px;font-size:13px;font-weight:800}.head-actions .primary{background:#fff;color:var(--navy)}.head-actions .secondary{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.15);color:#fff}.head-actions .stop{background:var(--red);color:#fff}
      .content-wrap{max-width:760px;margin:auto;padding:0 12px}.quick-tabs{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:12px 0}.quick-tabs button{min-height:40px;border:1px solid var(--line);border-radius:10px;background:#fff;color:#657080;font-size:11px;font-weight:750}.quick-tabs button.active{background:var(--navy);border-color:var(--navy);color:#fff}
      .radar-card{padding:13px;margin-bottom:12px;background:#fff;border:1px solid var(--line);border-radius:14px;box-shadow:0 5px 18px rgba(20,34,56,.06)}.radar-title{display:flex;justify-content:space-between;margin-bottom:10px}.radar-title b{font-size:13px}.radar-title span{font-size:9px;color:var(--muted)}.metric-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:7px}.metric{padding:9px;border-radius:10px;background:#f7f8fa}.metric label{display:block;font-size:9px;color:var(--muted)}.metric strong{display:block;margin-top:3px;font-size:16px}.metric small{display:block;margin-top:2px;font-size:8px;color:var(--muted)}
      details.section{display:block!important;margin:10px 0!important;background:var(--card)!important;border:1px solid var(--line)!important;border-radius:14px!important;overflow:hidden!important;box-shadow:0 5px 18px rgba(20,34,56,.055)!important}details.section summary{display:flex!important;align-items:center!important;min-height:50px;padding:14px!important;list-style:none!important;font-size:14px!important;font-weight:800!important;color:var(--ink)!important;border-bottom:1px solid transparent}details.section summary::-webkit-details-marker{display:none}details.section[open] summary{border-bottom-color:var(--line);background:#fbfcfd}details.section summary:after{content:"＋";margin-left:auto;color:#9aa4b1;font-size:17px}details.section[open] summary:after{content:"−"}.summary-note{margin-left:auto;margin-right:4px;font-size:9px;font-weight:500;color:var(--muted)}.content{padding:12px 13px 14px!important}.help{padding:9px!important;margin:0 0 10px!important;border-radius:9px!important;background:#f7f8fa!important;color:#667180!important;font-size:10px!important;line-height:1.6!important}.section-title{margin:14px 0 7px!important;padding-left:7px;border-left:2px solid var(--gold);font-size:10px!important;font-weight:800!important;color:#9a6b2c!important}.check{display:flex!important;align-items:center!important;gap:8px!important;min-height:37px!important;margin:5px 0!important;padding:7px 8px!important;border-radius:9px!important;background:#f8f9fb!important;font-size:11px!important}.check input{width:17px!important;height:17px!important;margin:0!important;accent-color:var(--blue)!important}input,select{min-height:37px!important;border:1px solid #dce2e8!important;border-radius:8px!important;padding:7px 8px!important;background:#fff!important;color:var(--ink)!important;font-size:11px!important}.grid{gap:8px!important}label.field{font-size:9px!important;color:var(--muted)!important}
      .core-card{border-color:#dce2ea!important}.gap-card{border-color:#d8e1ef!important}.news-card{border-color:#e1e5eb!important}.result-card{border:1px solid #e5e9ef!important;border-radius:11px!important;padding:11px!important;background:#fff!important}.result-card-title{font-size:13px!important;color:var(--navy)!important}.result-field-label{font-size:8px!important;color:var(--muted)!important}.result-field-value{font-size:11px!important;font-weight:700!important}.results-scroll{border-radius:10px}.results-scroll th{background:#f1f3f6!important;color:#566171!important;font-size:9px!important}.results-scroll th,.results-scroll td{padding:7px 6px!important}
      .advanced-zone{margin-top:14px}.advanced-title{margin:12px 3px 8px;font-size:11px;font-weight:800;color:#697586}.advanced-title:before{content:"";display:inline-block;width:3px;height:13px;margin-right:7px;border-radius:3px;background:#aeb7c3}.logbox{max-height:280px!important;border-radius:10px!important;font-size:9px!important}.log-actions{display:flex;justify-content:flex-end;margin:7px 0}.log-copy{border:1px solid var(--line);border-radius:8px;background:#fff;padding:6px 9px;color:#697586;font-size:9px;font-weight:700}
      .bottom-nav{position:fixed;left:0;right:0;bottom:0;z-index:100;display:grid;grid-template-columns:repeat(5,1fr);padding:6px 10px calc(6px + env(safe-area-inset-bottom));background:rgba(255,255,255,.97);backdrop-filter:blur(16px);border-top:1px solid #e3e7ec;box-shadow:0 -5px 18px rgba(20,34,56,.08)}.bottom-nav button{border:0;background:none;color:#8993a1;font-size:9px;font-weight:700;padding:4px 2px}.bottom-nav button b{display:block;margin-bottom:2px;font-size:17px;font-weight:500}.bottom-nav button.active{color:var(--navy)}
      .quick-tabs{position:sticky;top:0;z-index:30;background:var(--bg);padding:8px 0;margin:0 0 10px;grid-template-columns:repeat(6,1fr)}.quick-tabs button{font-size:10px;min-height:38px}.ui-module-hidden{display:none!important}.module-card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:12px;margin:10px 0}.module-card h3{font-size:13px;margin:0 0 5px}.module-card p{font-size:10px;line-height:1.55;color:var(--muted);margin:0 0 10px}.module-card .actions{margin-top:8px}.module-card .actions button{min-height:42px}.bottom-nav{display:none!important}@media(max-width:380px){.metric-grid{gap:5px}.metric{padding:8px 6px}.metric strong{font-size:14px}.quick-tabs{gap:3px}.quick-tabs button{font-size:9px}}@media(min-width:700px){.broker-head{padding-left:max(16px,calc((100% - 760px)/2 + 16px));padding-right:max(16px,calc((100% - 760px)/2 + 16px))}}
    `;
    document.head.appendChild(style);

    const shell = document.createElement("div");
    shell.id = "brokerShell";
    shell.innerHTML = `<header class="broker-head"><div class="head-row"><div class="brand">A股机会雷达<small>选股 · 高开概率 · 新闻情报</small></div><div class="market-status"><i class="market-dot" id="brokerDot"></i><span id="brokerStatus">就绪</span></div></div><div class="market-tape"><div class="tape-item"><b>沪深市场</b><span>实时行情</span></div><div class="tape-item"><b>量价资金</b><span>基础 + 技术</span></div><div class="tape-item"><b>T+1</b><span>历史统计</span></div></div><div class="head-actions"><button class="primary" id="proxyScreen">开始选股</button><button class="secondary" id="proxyMonitor">实时监控</button></div></header><main class="content-wrap"><div class="quick-tabs"><button data-target="screenArea" class="active">选股</button><button data-target="gapArea">高开</button><button data-target="monitorArea">监控</button><button data-target="resonanceArea">共振</button><button data-target="resultsSection">结果</button><button data-target="advancedArea">更多</button></div><div class="radar-card"><div class="radar-title"><b>今日雷达</b><span>核心指标</span></div><div class="metric-grid"><div class="metric"><label>候选股票</label><strong id="dashCandidates">待选</strong><small>基础 + 技术</small></div><div class="metric"><label>历史高开</label><strong id="dashGap">—</strong><small>T+1 样本</small></div><div class="metric"><label>新闻快讯</label><strong id="dashNews">—</strong><small>近期信息</small></div></div></div><div id="moduleHost"></div></main><nav class="bottom-nav"><button data-target="screenArea" class="active"><b>⌂</b>选股</button><button data-target="resultsSection"><b>▦</b>结果</button><button data-target="gapArea"><b>◒</b>高开</button><button data-target="newsArea"><b>◉</b>新闻</button><button data-target="advancedArea"><b>☷</b>更多</button></nav>`;
    document.body.insertBefore(shell, document.body.firstChild);

    const host = $("#moduleHost");
    [basic,result,gap,news].filter(Boolean).forEach((el) => host.appendChild(el));
    const advanced = document.createElement("div");
    advanced.id = "advancedArea";
    advanced.className = "advanced-zone";
    advanced.innerHTML = `<div class="advanced-title">高级工具</div>`;
    [tech,similar].filter(Boolean).forEach((el) => advanced.appendChild(el));
    host.appendChild(advanced);
    if (logs) { logs.id = "logsArea"; host.appendChild(logs); }

    // Second-round UX: keep the default workflow intentionally small.
    const quickTech = document.createElement("section");
    quickTech.className = "module-card quick-tech";
    quickTech.innerHTML = '<h3>常用技术条件 <span class="summary-note">可选</span></h3><p>新手模式只保留这 4 个容易理解的条件。勾选后会与基础筛选一起执行；未勾选不会生效。</p><div id="quickTechHost"></div>';
    const quickTechHost = quickTech.querySelector("#quickTechHost");
    ["enableMaBullish","enableMa5Bias","enableNearHigh","enableVolumeStair"].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const label = el.closest(".check");
      if (label) quickTechHost.appendChild(label);
    });

    const conditionSummary = document.createElement("section");
    conditionSummary.className = "module-card condition-summary";
    conditionSummary.innerHTML = '<div class="condition-head"><b>本次运行条件</b><span id="conditionMode">新手模式</span></div><div id="conditionList" class="condition-list"></div><div class="condition-foot">只有这里列出的条件会参与“开始选股”。高开、监控、共振是独立任务。</div>';
    const updateConditionSummary = () => {
      const ids = [
        ["enablePct","涨幅"],["enableTurnover","换手率"],["enableVolumeRatio","量比"],
        ["enableCircMv","流通市值"],["enableProfitable","盈利企业"],["enableMainInflow","主力净流入"],
        ["enableMaBullish","均线多头"],["enableMa5Bias","贴近5日线"],["enableNearHigh","接近20日高点"],
        ["enableVolumeStair","台阶放量"],["enableHotBoard","热点板块"],["enableStrongerThanIndex","强于大盘"],
        ["enableLimitUp","近N日涨停"],["enableLhbCount","龙虎榜"],["enableVwap","站上分时均价"],
        ["enableTailHigh","14:30后新高"],["enableRapidRise","分时急拉"]
      ];
      const active = ids.filter(([id]) => document.getElementById(id)?.checked).map(([,name]) => name);
      const list = document.getElementById("conditionList");
      if (list) list.innerHTML = active.length
        ? active.map((name) => '<span class="condition-chip">'+name+'</span>').join("")
        : '<span class="condition-empty">未启用筛选条件</span>';
    };
    conditionSummary.querySelector("#conditionMode").textContent = "新手模式";
    quickTech.addEventListener("change", updateConditionSummary);
    basic.addEventListener("change", updateConditionSummary);
    screen.addEventListener("click", () => setTimeout(updateConditionSummary, 50));
    screen.parentNode?.insertBefore(conditionSummary, screen);
    screen.parentNode?.insertBefore(quickTech, conditionSummary.nextSibling);

    const modeBar = document.createElement("div");
    modeBar.className = "mode-bar";
    modeBar.innerHTML = '<button class="mode active" data-mode="simple">新手模式</button><button class="mode" data-mode="advanced">高级模式</button>';
    screen.parentNode?.insertBefore(modeBar, conditionSummary);

    const setMode = (mode) => {
      const simple = mode === "simple";
      quickTech.style.display = simple ? "block" : "none";
      advanced.style.display = simple ? "none" : "block";
      conditionSummary.querySelector("#conditionMode").textContent = simple ? "新手模式" : "高级模式";
      modeBar.querySelectorAll(".mode").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
      updateConditionSummary();
    };
    modeBar.querySelectorAll(".mode").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
    setMode("simple");
    const monitorPanel = document.createElement("section");
    monitorPanel.id = "monitorArea";
    monitorPanel.className = "module-card";
    monitorPanel.innerHTML = '<h3>③ 实时监控</h3><p>独立任务：不继承普通选股条件，只监控盘中急速拉升和主力净流入 ≥ 1000 万。无需先运行“开始选股”。</p><div class="grid"><label class="field">刷新间隔（秒）<input id="monitorIntervalUi" type="number" min="15" value="15"></label><label class="field">急拉窗口（分钟）<input id="monitorRapidWindow" type="number" min="1" value="5"></label><label class="field">最小急拉涨幅 %<input id="monitorRapidPct" type="number" step="0.1" value="2"></label><label class="field">最小放量倍数<input id="monitorRapidVolume" type="number" step="0.1" value="1.5"></label><label class="field">跳过开盘分钟<input id="monitorSkipOpen" type="number" min="0" value="5"></label></div><label class="check"><input id="monitorNotifyUi" type="checkbox" checked>命中时发送提醒</label><div class="actions"></div>';
    monitorPanel.querySelector(".actions").appendChild($("#monitorButton"));
    const resonancePanel = document.createElement("section");
    resonancePanel.id = "resonanceArea";
    resonancePanel.className = "module-card";
    resonancePanel.innerHTML = '<h3>④ 资金/机构共振</h3><p>完全独立运行，不自动叠加普通选股条件。选择一档规则后直接执行；结果进入“结果”页。</p><div id="resonanceHost"></div>';
    const resonanceTitle = tech && $(".section-title", tech).find((x) => (x.textContent || "").includes("资金/机构共振"));
    const boardTitle = tech && $(".section-title", tech).find((x) => (x.textContent || "").includes("板块与强势"));
    if (resonanceTitle && boardTitle) { let n = resonanceTitle; const hostBox = $("#resonanceHost"); while (n && n !== boardTitle) { const next = n.nextElementSibling; hostBox.appendChild(n); n = next; } }
    const resonanceHost = $("#resonanceHost");
    if (resonanceHost) { const btn = $("#resonanceButton"); if (btn) resonanceHost.appendChild(btn); }
    host.appendChild(monitorPanel);
    host.appendChild(resonancePanel);
    if (basic) basic.id = "screenArea";
    if (result) result.id = "resultsSection";
    if (gap) gap.id = "gapArea";
    if (news) news.id = "newsArea";
    const summary = (el, title, note) => {
      const s = el && $("summary", el);
      if (s) s.innerHTML = `${title}<span class="summary-note">${note}</span>`;
    };
    summary(basic,"① 今日选股","基础条件 · 技术形态");
    summary(result,"选股结果","候选池");
    summary(gap,"② 高开概率","T+1 历史统计");
    summary(news,"③ 近期新闻","隔夜 · 7×24");
    summary(tech,"技术形态","趋势 · 强势 · 突破");
    summary(similar,"相似走势","历史形态匹配");
    summary(logs,"运行日志","诊断 · 调试");
    [basic,result,gap,news].filter(Boolean).forEach((el) => el.classList.add("core-card"));
    if (gap) gap.classList.add("gap-card");
    if (news) news.classList.add("news-card");

    const bh = basic && $(".help", basic);
    if (bh) bh.textContent = "设置基础条件和技术形态后，点击“开始选股”，筛出当日符合条件的股票。";
    const gh = gap && $(".help", gap);
    if (gh) gh.textContent = "高开概率来自历史 T+1 统计：使用历史相似条件，统计次日开盘相对前收的表现。历史统计不代表明日结果。";

    const click = (id) => { const b = $(id); if (b) b.click(); };
    $("#proxyScreen").onclick = () => click("#screenButton");
    $("#proxyMonitor").onclick = () => click("#monitorButton");

    const moduleTargets = ["screenArea","gapArea","monitorArea","resonanceArea","resultsSection","advancedArea","logsArea"];
    const showModule = (id) => {
      moduleTargets.forEach((name) => {
        const el = document.getElementById(name);
        if (!el) return;
        const visible = id === "resultsSection" ? (name === "resultsSection" || name === "logsArea") : name === id;
        el.classList.toggle("ui-module-hidden", !visible);
      });
      $('[data-target]').forEach((x) => x.classList.toggle("active", x.dataset.target === id));
      const target = document.getElementById(id);
      if (target && target.tagName.toLowerCase() === "details") target.open = true;
      window.scrollTo(0, 0);
    };
    $('[data-target]').forEach((b) => b.addEventListener("click", () => showModule(b.dataset.target)));
    showModule("screenArea");

    const status = $("#status");
    const updateState = () => {
      const text = status ? status.textContent || "就绪" : "就绪";
      const label = $("#brokerStatus");
      if (label) label.textContent = text;
      const running = /正在|分析中|监控中|回测中|扫描/.test(text) && !/完成|已停止|就绪/.test(text);
      const error = /失败|错误/.test(text);
      const dot = $("#brokerDot");
      if (dot) dot.className = `market-dot ${running ? "run" : error ? "err" : ""}`;
      const btn = $("#proxyScreen");
      if (btn) { btn.textContent = running ? "取消任务" : "开始选股"; btn.classList.toggle("stop", running); btn.onclick = running ? () => click("#cancelButton") : () => click("#screenButton"); }
    };
    if (status) new MutationObserver(updateState).observe(status,{childList:true,characterData:true,subtree:true});
    updateState();

    const updateMetrics = () => {
      const r = $("#results");
      const count = r ? Math.max(r.querySelectorAll(".result-card").length, r.querySelectorAll("tbody tr").length) : 0;
      const c = $("#dashCandidates"); if (c) c.textContent = count ? `${count}只` : "待选";
      const badge = $("#resultBadge"); if (badge) badge.textContent = `${count} 条`;
      const bt = $("#backtestSummary") || $(".backtest-summary");
      const gapKpi = $("#dashGap");
      if (bt && gapKpi) { const m = (bt.textContent || "").match(/高开[^\d]*(\d+(?:\.\d+)?)%/); if (m) gapKpi.textContent = `${m[1]}%`; }
      const ns = $("#newsStatus");
      const newsKpi = $("#dashNews");
      if (ns && newsKpi) { const m = (ns.textContent || "").match(/(\d+)\s*(?:条|则)/); if (m) newsKpi.textContent = `${m[1]}条`; }
    };
    const results = $("#results");
    if (results) new MutationObserver(updateMetrics).observe(results,{childList:true,subtree:true,characterData:true});
    setTimeout(updateMetrics,300);

    const log = $("#log");
    if (log) {
      const actions = document.createElement("div"); actions.className = "log-actions";
      const copy = document.createElement("button"); copy.className = "log-copy"; copy.textContent = "复制日志";
      copy.onclick = async () => {
        const text = log.textContent.trim() || "暂无运行日志";
        try { await navigator.clipboard.writeText(text); } catch (_) { const ta=document.createElement("textarea"); ta.value=text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); }
        copy.textContent = "已复制"; setTimeout(() => { copy.textContent = "复制日志"; }, 1200);
      };
      actions.appendChild(copy); log.parentNode && log.parentNode.insertBefore(actions,log);
    }

    [basic,result,gap,news].filter(Boolean).forEach((el) => { el.open = false; });
    if (basic) basic.open = true;
    // Independent monitor controls are intentionally not mirrored into the old technical section.
    const monitorIds = ["monitorIntervalUi","monitorRapidWindow","monitorRapidPct","monitorRapidVolume","monitorSkipOpen"];
    monitorIds.forEach((id) => {
      const el = $("#" + id);
      if (el) el.addEventListener("change", () => {});
    });
    const monitorNotify = $("#monitorNotifyUi");
    if (monitorNotify) monitorNotify.addEventListener("change", () => {});
    const oldMonitor = $("#monitorInterval");
    if (oldMonitor) oldMonitor.closest("label.field")?.style.setProperty("opacity", "0.45");
    const enableResonance = $("#enableResonance");
    if (enableResonance) { const label = enableResonance.closest(".check"); if (label) label.style.display = "none"; }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded",boot,{once:true});
  else boot();
})();
