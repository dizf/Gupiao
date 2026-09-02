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
  const resultBadge = $("#resultBadge");

  function activeToken() {
    return window.__backtestToken || window.__gupiaoActiveToken ||
      window.__gupiaoActiveToken === null ? window.__gupiaoActiveToken :
      (window.__backtestToken || null);
  }

  function stopAll() {
    if (window.__backtestToken) stopToken(window.__backtestToken);
    [window.__gupiaoScreenToken, window.__gupiaoMonitorToken, window.__gupiaoSimilarToken]
      .filter(Boolean).forEach((t) => stopToken(t));
    if (window.__gupiaoActiveToken) stopToken(window.__gupiaoActiveToken);
    setTimeout(refreshState, 50);
  }

  function refreshState() {
    const running = Boolean(window.__backtestToken || window.__gupiaoScreenToken || window.__gupiaoMonitorToken || window.__gupiaoSimilarToken || window.__gupiaoActiveToken);
    if (cancelBtn) cancelBtn.classList.toggle("show", running);
    [screenBtn, monitorBtn, similarBtn, backtestBtn].forEach((btn) => {
      if (!btn) return;
      const runningButton = /停止|停止中|取消/.test(btn.textContent);
      btn.classList.toggle("running", runningButton);
      btn.setAttribute("aria-busy", runningButton ? "true" : "false");
    });
    if (dot && running) dot.className = "dot running";
  }

  function decorateStatus() {
    if (!status || !dot) return;
    const text = status.textContent || "";
    const running = /正在|分析中|监控中|回测中/.test(text);
    const error = /失败|错误/.test(text);
    dot.className = `dot ${running ? "running" : error ? "error" : /完成|停止|就绪|已保存/.test(text) ? "success" : ""}`;
    refreshState();
  }

  let renderingLog = false;
  function highlightLog() {
    if (!log || renderingLog) return;
    const text = log.textContent || "";
    const lines = text.split("\n").filter(Boolean).slice(-100);
    renderingLog = true;
    log.innerHTML = lines.map((line, index) => {
      let cls = "info";
      if (/排除|关闭|没有|不足|停止/.test(line)) cls = "warn";
      if (/失败|错误/.test(line)) cls = "error";
      if (/完成|成功|剩余 \d+ 只|合计：/.test(line)) cls = "ok";
      if (index === lines.length - 1) cls += " latest";
      return `<div class="logline ${cls}">${escapeHtml(line)}</div>`;
    }).join("");
    log.scrollTop = log.scrollHeight;
    renderingLog = false;
  }

  function updateResultBadge() {
    if (!resultBadge) return;
    const rows = window.state?.exportRows || window.state?.screenRows || [];
    resultBadge.textContent = `${rows.length || 0} 条`;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }

  if (cancelBtn) cancelBtn.addEventListener("click", stopAll);
  const logButton = $("#scrollLogButton");
  if (logButton) logButton.addEventListener("click", () => {
    const section = $("#logSection");
    if (section) section.open = true;
    setTimeout(() => $("#log")?.scrollIntoView({ behavior: "smooth", block: "center" }), 30);
  });
  const exportSimilar = $("#exportButton2");
  if (exportSimilar) exportSimilar.addEventListener("click", () => window.saveResult?.());

  if (status) new MutationObserver(decorateStatus).observe(status, { childList: true, characterData: true, subtree: true });
  if (log) new MutationObserver(() => { if (!renderingLog) highlightLog(); }).observe(log, { childList: true, characterData: true, subtree: true });
  setInterval(refreshState, 250);
  setInterval(updateResultBadge, 500);
  decorateStatus();
  highlightLog();
})();
