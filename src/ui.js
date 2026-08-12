// WebLogic Monitor - In-Page Glassmorphic UI Overlay
const WLUI = (() => {
  let activeTab = "monitor";
  let countdown = 10;
  let isMuted = false;
  let isAcked = false;

  let currentPage = 1;
  let pageSize = 10;

  let container = null;

  function createWidget() {
    const href = (window.location && window.location.href) ? window.location.href.toLowerCase() : "";
    const title = (document.title || "").toLowerCase();
    if (!href.includes("/console") && !href.includes(":7001") && !href.includes(":7002") && !href.includes("console.portal") && !title.includes("summary of servers")) {
      return; // 🛑 Block floating widget on YouTube, GitHub, Google, etc.!
    }

    if (document.getElementById("wl-monitor-widget")) return;

    container = document.createElement("div");
    container.id = "wl-monitor-widget";
    container.className = "wl-widget-container";

    container.innerHTML = `
      <div class="wl-widget-header" id="wlWidgetHeader">
        <div class="wl-widget-title">
          <span class="wl-dot"></span> WebLogic Monitor
        </div>
        <div class="wl-widget-timer" id="wlCountdown">10s</div>
      </div>
      <div class="wl-widget-toolbar">
        <button id="wlMuteBtn" title="Toggle Sound Alerts">🔈</button>
        <button id="wlAckBtn">ACK</button>
        <button id="wlTabMonitor" class="active">Monitor</button>
        <button id="wlTabSettings">Settings</button>
        <button id="wlTabImp">Impact History</button>
        <button id="wlTabAll">All History</button>
        <button id="wlExportToday" title="Export Today CSV">📥 Today</button>
        <button id="wlExportAll" title="Export All CSV">📥 All</button>
      </div>
      <div class="wl-widget-content" id="wlWidgetContent">
        <div class="wl-loading">Initializing WebLogic Monitor...</div>
      </div>
      <div class="wl-widget-footer">
        <span>Domain: <strong id="wlDomainTag">Detecting...</strong></span>
        <span class="wl-author">Mashkoor</span>
      </div>
    `;

    document.body.appendChild(container);
    makeDraggable(container, document.getElementById("wlWidgetHeader"));
    bindEvents();
    startTimer();
  }

  function bindEvents() {
    const muteBtn = document.getElementById("wlMuteBtn");
    const ackBtn = document.getElementById("wlAckBtn");

    const tabMonitor = document.getElementById("wlTabMonitor");
    const tabSettings = document.getElementById("wlTabSettings");
    const tabImp = document.getElementById("wlTabImp");
    const tabAll = document.getElementById("wlTabAll");

    const exportToday = document.getElementById("wlExportToday");
    const exportAll = document.getElementById("wlExportAll");

    muteBtn.onclick = () => {
      isMuted = !isMuted;
      muteBtn.textContent = isMuted ? "🔇" : "🔈";
      if (window.WLAlerts) window.WLAlerts.setMuted(isMuted);
    };

    if (ackBtn) {
      ackBtn.onclick = () => {
        isAcked = true;
        ackBtn.textContent = "ACKED";
        ackBtn.style.background = "#10b981";
        if (window.WLAlerts) window.WLAlerts.acknowledgeAll();
        try {
          if (chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({ type: "ACK_ALL_ALERTS" });
          }
        } catch (e) {}
      };
    }

    const setTab = (tabName, btnElem) => {
      activeTab = tabName;
      document.querySelectorAll(".wl-widget-toolbar button").forEach(b => {
        if (b.id.startsWith("wlTab")) b.classList.remove("active");
      });
      btnElem.classList.add("active");
      render();
    };

    tabMonitor.onclick = () => setTab("monitor", tabMonitor);
    tabSettings.onclick = () => setTab("settings", tabSettings);
    tabImp.onclick = () => setTab("history_imp", tabImp);
    tabAll.onclick = () => setTab("history_all", tabAll);

    exportToday.onclick = () => exportCSV(true);
    exportAll.onclick = () => exportCSV(false);
  }

  function render() {
    const content = document.getElementById("wlWidgetContent");
    if (!content) return;

    const domainTag = document.getElementById("wlDomainTag");
    if (window.WLMonitorEngine) {
      domainTag.textContent = window.WLMonitorEngine.getDomainKey();
    }

    switch (activeTab) {
      case "monitor":
        renderMonitor(content);
        break;
      case "settings":
        // 🛡️ DO NOT RE-RENDER SETTINGS IF ALREADY OPEN: Prevents inputs from wiping out every second!
        if (content.querySelector(".wl-settings-table")) {
          return;
        }
        renderBookmarkletStyleSettings(content);
        break;
      case "history_imp":
        if (content.querySelector(".wl-history-table[data-type='imp']")) {
          return;
        }
        renderHistory(content, window.WLStorage?.STORES?.NODE_HISTORY || "nodeHistory", "imp");
        break;
      case "history_all":
        if (content.querySelector(".wl-history-table[data-type='all']")) {
          return;
        }
        renderHistory(content, window.WLStorage?.STORES?.ALL_EVENTS || "allEvents", "all");
        break;
    }
  }

  function renderMonitor(content) {
    const impacted = window.WLMonitorEngine ? window.WLMonitorEngine.getImpacted() : {};
    const keys = Object.keys(impacted);

    if (keys.length === 0) {
      content.innerHTML = `<div class="wl-empty">🟢 No impacted nodes.</div>`;
      return;
    }

    let html = "";
    keys.forEach((nodeName) => {
      const item = impacted[nodeName];
      const startMs = item.startTime || item.lastUpdate || Date.now();
      const durationStr = formatDuration(startMs, null);
      const isCritical = item.severity === "CRITICAL";

      html += `
        <div class="wl-card ${isCritical ? 'critical' : 'warning'}">
          <div class="wl-card-header">
            <strong>${item.node || item.name || nodeName}</strong>
            <span class="wl-badge ${isCritical ? 'critical' : 'warning'}">[${item.severity}]</span>
          </div>
          <div class="wl-card-body">
            Health: ${item.health || "UNKNOWN"} | Sockets: ${item.sockets} | State: ${item.state || "UNKNOWN"}
            ${item.stuckThreads ? `<br><span class="wl-stuck">Stuck: ${item.stuckThreads}</span>` : ''}
            <br>Duration: <strong>${durationStr}</strong>
          </div>
        </div>
      `;
    });

    content.innerHTML = html;
  }

  // Exact Bookmarklet Settings Table Implementation (Node | Threshold | Ignore + Save Button)
  function renderBookmarkletStyleSettings(content) {
    const table = document.querySelector("#genericTableFormtable") || document.querySelector("table");
    if (!table) {
      content.innerHTML = `<i>Table not found</i>`;
      return;
    }

    const headers = [...table.querySelectorAll("th")].map(th => th.innerText.toUpperCase());
    const nameCol = headers.findIndex(h => h.includes("NAME") || h.includes("SERVER"));

    if (nameCol === -1) {
      content.innerHTML = `<i>Server Name column not found</i>`;
      return;
    }

    let html = `
      <table class="wl-settings-table" style="width:100%; font-size:12px; border-collapse:collapse;">
        <thead>
          <tr style="border-bottom:1px solid #444; text-align:left;">
            <th style="padding:4px;">Node</th>
            <th style="padding:4px;">Threshold</th>
            <th style="padding:4px;">Ignore</th>
          </tr>
        </thead>
        <tbody>
    `;

    const currentDomain = window.WLMonitorEngine ? window.WLMonitorEngine.getDomainKey() : (window.WLStorage ? window.WLStorage.getDomainKey() : "");

    table.querySelectorAll("tr.rowEven, tr.rowOdd, tr").forEach((row) => {
      const cells = row.querySelectorAll("td");
      const name = cells[nameCol]?.innerText?.trim();
      if (!name) return;

      const currentTh = window.WLSettings ? window.WLSettings.getThreshold(name, currentDomain) : 70;
      const isIgnored = window.WLSettings ? window.WLSettings.isIgnored(name, currentDomain) : false;

      html += `
        <tr style="border-bottom:1px solid #333;">
          <td style="padding:4px; font-weight:600;">${name}</td>
          <td style="padding:4px;"><input type="number" value="${currentTh}" data-n="${name}" style="width:60px; background:#222; color:#fff; border:1px solid #555; padding:2px; border-radius:4px;"></td>
          <td style="padding:4px;"><input type="checkbox" data-i="${name}" ${isIgnored ? 'checked' : ''}></td>
        </tr>
      `;
    });

    html += `
        </tbody>
      </table>
      <button id="sv" style="margin-top:8px; padding:4px 12px; border-radius:5px; border:none; background:#3b82f6; color:#fff; cursor:pointer; font-weight:600;">Save</button>
    `;

    content.innerHTML = html;

    // Instant Change Handlers
    content.querySelectorAll("input[data-i]").forEach((chk) => {
      chk.addEventListener("change", (e) => {
        const nodeName = e.target.dataset.i;
        if (window.WLSettings) {
          window.WLSettings.setIgnored(nodeName, e.target.checked, currentDomain);
        }
      });
    });

    content.querySelectorAll("input[data-n]").forEach((inp) => {
      inp.addEventListener("change", (e) => {
        const nodeName = e.target.dataset.n;
        const val = Number(e.target.value);
        if (window.WLSettings && !isNaN(val)) {
          window.WLSettings.setThreshold(nodeName, val, currentDomain);
        }
      });
    });

    document.getElementById("sv").onclick = () => {
      content.querySelectorAll("input[data-n]").forEach((inp) => {
        const nodeName = inp.dataset.n;
        const val = Number(inp.value);
        if (window.WLSettings && !isNaN(val)) {
          window.WLSettings.setThreshold(nodeName, val, currentDomain);
        }
      });

      content.querySelectorAll("input[data-i]").forEach((inp) => {
        const nodeName = inp.dataset.i;
        if (window.WLSettings) {
          window.WLSettings.setIgnored(nodeName, inp.checked, currentDomain);
        }
      });

      alert("Saved for domain " + (currentDomain || "global"));
    };
  }

  function formatDuration(startMs, endMs) {
    if (!startMs) return "--";
    const start = (typeof startMs === "number") ? startMs : new Date(startMs).getTime();
    if (isNaN(start)) return "--";
    const end = endMs ? ((typeof endMs === "number") ? endMs : new Date(endMs).getTime()) : Date.now();
    const diffSec = Math.max(0, Math.floor((end - start) / 1000));
    const mins = Math.floor(diffSec / 60);
    const secs = diffSec % 60;
    if (mins >= 60) {
      const hrs = Math.floor(mins / 60);
      const remMins = mins % 60;
      return `${hrs}h ${remMins}m`;
    }
    return `${mins}m ${secs}s`;
  }

  function safeSendMessage(msg, callback) {
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage(msg, (response) => {
          if (chrome.runtime.lastError) {
            // Silently handle context sleeping
          }
          if (callback) callback(response);
        });
      } else if (callback) {
        callback(null);
      }
    } catch (e) {
      if (callback) callback(null);
    }
  }

  function resolveDomainKey() {
    if (window.WLMonitorEngine && typeof window.WLMonitorEngine.getDomainKey === "function") {
      const key = window.WLMonitorEngine.getDomainKey();
      if (key && key !== "UNKNOWN_DOMAIN" && key !== "UNKNOWN") return key;
    }
    const domainElem = document.querySelector("#domain strong");
    if (domainElem && domainElem.textContent.trim()) {
      return domainElem.textContent.trim().replace(/-/g, "_");
    }
    return window.location.host || "UNKNOWN_DOMAIN";
  }

  async function renderHistory(content, storeName, tabType = "imp") {
    const currentDomain = resolveDomainKey();

    const rawEvents = await new Promise((resolve) => {
      const filterDomain = (storeName === "nodeHistory" || storeName === "impactHistory") ? currentDomain : null;
      safeSendMessage({ type: "GET_GLOBAL_EVENTS", domainKey: filterDomain }, (res) => {
        resolve(Array.isArray(res) ? res : []);
      });
    });
    const seenMap = new Map();
    rawEvents.forEach(item => {
      const startMs = item.startTime ? new Date(item.startTime).getTime() : new Date(item.time || 0).getTime();
      const domKey = (item.domain || 'DEFAULT').replace(/-/g, '_');
      const key = item.incidentId || `${domKey}_${item.node}_${startMs}`;
      if (!seenMap.has(key)) {
        seenMap.set(key, item);
      } else {
        const existing = seenMap.get(key);
        if (item.endTime && !existing.endTime) {
          seenMap.set(key, item);
        }
      }
    });
    const events = Array.from(seenMap.values());
    events.sort((a, b) => {
      const aMs = a.startTime ? new Date(a.startTime).getTime() : new Date(a.time || 0).getTime();
      const bMs = b.startTime ? new Date(b.startTime).getTime() : new Date(b.time || 0).getTime();
      return bMs - aMs;
    });

    if (events.length === 0) {
      content.innerHTML = `<div class="wl-empty">No history logs recorded in ${storeName}.</div>`;
      return;
    }

    const totalPages = Math.max(1, Math.ceil(events.length / pageSize));
    currentPage = Math.min(Math.max(1, currentPage), totalPages);

    const startIdx = (currentPage - 1) * pageSize;
    const pageItems = events.slice(startIdx, startIdx + pageSize);

    let html = `
      <div class="wl-history-header" style="margin-bottom:6px;">
        Page Size:
        <select id="ps" style="background:#222; color:#fff; border:1px solid #444; padding:2px; border-radius:4px;">
          <option ${pageSize === 10 ? 'selected' : ''}>10</option>
          <option ${pageSize === 25 ? 'selected' : ''}>25</option>
          <option ${pageSize === 50 ? 'selected' : ''}>50</option>
          <option ${pageSize === 100 ? 'selected' : ''}>100</option>
        </select>
      </div>
      <table class="wl-history-table" data-type="${tabType}" style="width:100%; font-size:11px; border-collapse:collapse;">
        <thead>
          <tr style="border-bottom:1px solid #444; text-align:left;">
            <th>ID</th>
            <th>Node</th>
            <th>Start Time</th>
            <th>Recovery Time</th>
            <th>Duration</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
    `;

    pageItems.forEach((item, idx) => {
      const startMs = item.startTime ? new Date(item.startTime).getTime() : new Date(item.time || 0).getTime();
      const endMs = item.endTime ? new Date(item.endTime).getTime() : null;
      const startDisplay = item.startDisplay || (startMs ? new Date(startMs).toLocaleTimeString() : "--");
      const recoveryDisplay = item.endDisplay || (endMs ? new Date(endMs).toLocaleTimeString() : '<span style="color:#f59e0b;font-weight:600;">⚡ ACTIVE</span>');
      const durationStr = formatDuration(startMs, endMs);
      const statusBadge = item.endTime
        ? '<span class="wl-tag NORMAL" style="background:rgba(34,197,94,0.2);color:#4ade80;border:1px solid rgba(34,197,94,0.4);">🟢 RECOVERED</span>'
        : '<span class="wl-tag WARNING" style="background:rgba(245,158,11,0.2);color:#fbbf24;border:1px solid rgba(245,158,11,0.4);">⚡ ACTIVE</span>';

      html += `
        <tr style="border-bottom:1px solid #333;">
          <td>${startIdx + idx + 1}</td>
          <td style="font-weight:600;">${item.node}</td>
          <td>${startDisplay}</td>
          <td>${recoveryDisplay}</td>
          <td style="font-weight:600;color:#f8fafc;">${durationStr}</td>
          <td>${statusBadge}</td>
        </tr>
      `;
    });

    html += `
        </tbody>
      </table>
      <div style="margin-top:8px; display:flex; align-items:center; gap:6px;">
        <button id="pBtn" style="padding:2px 8px; background:#444; color:#fff; border:none; border-radius:4px; cursor:pointer;" ${currentPage === 1 ? 'disabled' : ''}>◀</button>
        <span>Page ${currentPage} / ${totalPages}</span>
        <button id="nBtn" style="padding:2px 8px; background:#444; color:#fff; border:none; border-radius:4px; cursor:pointer;" ${currentPage === totalPages ? 'disabled' : ''}>▶</button>
      </div>
    `;

    content.innerHTML = html;

    const pBtn = document.getElementById("pBtn");
    const nBtn = document.getElementById("nBtn");
    const psSelect = document.getElementById("ps");

    if (pBtn) pBtn.onclick = () => { currentPage--; renderHistory(content, storeName); };
    if (nBtn) nBtn.onclick = () => { currentPage++; renderHistory(content, storeName); };
    if (psSelect) psSelect.onchange = (e) => {
      pageSize = parseInt(e.target.value, 10);
      currentPage = 1;
      renderHistory(content, storeName);
    };
  }

  async function exportCSV(todayOnly) {
    if (!window.WLStorage) return;
    const events = await window.WLStorage.getAll(window.WLStorage.STORES.ALL_EVENTS);

    if (!events.length) {
      alert("No logs available to export.");
      return;
    }

    const todayStr = new Date().toLocaleDateString();
    let csv = "\uFEFFID,Node,Time,Health,Sockets,State,Severity\n";

    events.forEach((item, idx) => {
      if (todayOnly && new Date(item.time).toLocaleDateString() !== todayStr) return;
      csv += [
        idx + 1,
        `"${item.node || ''}"`,
        `"${item.displayTime || item.time || ''}"`,
        `"${item.health || ''}"`,
        item.sockets || 0,
        `"${item.state || ''}"`,
        `"${item.severity || ''}"`
      ].join(",") + "\n";
    });

    const domainName = window.WLMonitorEngine ? window.WLMonitorEngine.getDomainKey() : "Domain";
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `WLMonitor_${domainName}_${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function startTimer() {
    setInterval(() => {
      countdown--;
      if (countdown <= 0) countdown = 10;
      const cdElem = document.getElementById("wlCountdown");
      if (cdElem) cdElem.textContent = `${countdown}s`;

      if (activeTab === "monitor") render();
    }, 1000);
  }

  function makeDraggable(element, handle) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    handle.onmousedown = dragMouseDown;

    function dragMouseDown(e) {
      e.preventDefault();
      pos3 = e.clientX;
      pos4 = e.clientY;
      document.onmouseup = closeDragElement;
      document.onmousemove = elementDrag;
    }

    function elementDrag(e) {
      e.preventDefault();
      pos1 = pos3 - e.clientX;
      pos2 = pos4 - e.clientY;
      pos3 = e.clientX;
      pos4 = e.clientY;
      element.style.top = (element.offsetTop - pos2) + "px";
      element.style.left = (element.offsetLeft - pos1) + "px";
    }

    function closeDragElement() {
      document.onmouseup = null;
      document.onmousemove = null;
    }
  }

  function isWebLogicConsolePage() {
    const href = (location.href || "").toLowerCase();
    const title = (document.title || "").toLowerCase();

    if (href.includes("/console") || href.includes("console.portal") || href.includes(":7001") || href.includes(":7002")) {
      return true;
    }

    if (document.querySelector("#genericTableFormtable") || document.querySelector("tr.rowEven, tr.rowOdd") || title.includes("weblogic") || title.includes("summary of servers")) {
      return true;
    }

    return false;
  }

  return {
    init: () => {
      if (!isWebLogicConsolePage()) return;
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", createWidget);
      } else {
        createWidget();
      }
    },
    render
  };
})();

window.WLUI = WLUI;

// Auto-initialize widget ONLY on WebLogic Admin Console pages
if (typeof location !== "undefined") {
  const href = (location.href || "").toLowerCase();
  const title = (document.title || "").toLowerCase();
  if (href.includes("/console") || href.includes("console.portal") || href.includes(":7001") || href.includes(":7002") || title.includes("weblogic") || title.includes("summary of servers")) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => WLUI.init());
    } else {
      WLUI.init();
    }
  }
}