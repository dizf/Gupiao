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

  function taskButtons() { return [screenBtn, monitorBtn, similarBtn, backtestBtn].filter(Boolean); }
  function runningButton(btn) { return /停止/.test(btn?.textContent || ""); }

  function stopAll() {
    const running = taskButtons().filter(runningButton);
    running.forEach((btn) => btn.click());
    if (!running.length && window.__backtestToken && typeof stopToken === "function") stopToken(window.__backtestToken);
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
    const running = /正在|分析中|监控中|回测中/.test(text);
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
  }

  if (cancelBtn) cancelBtn.addEventListener("click", stopAll);
  const logButton = $("#scrollLogButton");
  if (logButton) logButton.addEventListener("click", () => {
    const section = $("#logSection");
    if (section) section.open = true;
    setTimeout(() => log?.scrollIntoView({ behavior: "smooth", block: "center" }), 30);
  });

  // 在运行日志标题旁增加“复制日志”，下次遇到问题可直接复制后粘贴到聊天里。
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
  if (status) new MutationObserver(decorateStatus).observe(status, { childList: true, characterData: true, subtree: true });
  if (log) {
    logObserver = new MutationObserver(() => {
      if (!renderingLog) highlightLog();
    });
    logObserver.observe(log, { childList: true, characterData: true, subtree: true });
  }
  if (results) new MutationObserver(updateResultBadge).observe(results, { childList: true, subtree: true });
  setInterval(refreshState, 250);
  setInterval(updateResultBadge, 500);
  decorateStatus();
  highlightLog();
})();
