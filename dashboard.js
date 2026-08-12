document.addEventListener("DOMContentLoaded", () => {
  const kpiCritical = document.getElementById("kpiCritical");
  const kpiWarning = document.getElementById("kpiWarning");
  const kpiHealthy = document.getElementById("kpiHealthy");
  const kpiTabs = document.getElementById("kpiTabs");

  const tclCluster = document.getElementById("tclCluster");
  const tclGrid = document.getElementById("tclGrid");
  const hflCluster = document.getElementById("hflCluster");
  const hflGrid = document.getElementById("hflGrid");
  const collCluster = document.getElementById("collCluster");
  const collGrid = document.getElementById("collGrid");
  const ignoredCluster = document.getElementById("ignoredCluster");
  const ignoredGrid = document.getElementById("ignoredGrid");
  const noDomainsPlaceholder = document.getElementById("noDomainsPlaceholder");

  const tabActiveIncidents = document.getElementById("tabActiveIncidents");
  const tabAllImpacted = document.getElementById("tabAllImpacted");
  const eventsTableBody = document.getElementById("eventsTableBody");

  const searchInput = document.getElementById("searchInput");
  const muteBtn = document.getElementById("muteBtn");
  const globalAckBtn = document.getElementById("globalAckBtn");
  const exportTodayBtn = document.getElementById("exportTodayBtn");
  const exportAllBtn = document.getElementById("exportAllBtn");

  const settingsModalBtn = document.getElementById("settingsModalBtn");
  const settingsModal = document.getElementById("settingsModal");
  const closeModalBtn = document.getElementById("closeModalBtn");
  const saveConfigBtn = document.getElementById("saveConfigBtn");
  const resetConfigBtn = document.getElementById("resetConfigBtn");

  const cfgThreshold = document.getElementById("cfgThreshold");
  const cfgInterval = document.getElementById("cfgInterval");
  const cfgAlertRepeat = document.getElementById("cfgAlertRepeat");
  const cfgRetention = document.getElementById("cfgRetention");
  const cfgEnableSound = document.getElementById("cfgEnableSound");
  const cfgEnableNotify = document.getElementById("cfgEnableNotify");

  let isMuted = false;
  let searchTerm = "";
  let audioCtx = null;
  let currentAuditTab = "active";
  let isFetchingData = false; // ✅ FIX 6: Concurrency lock

  tabActiveIncidents.addEventListener("click", () => {
    currentAuditTab = "active";
    tabActiveIncidents.classList.add("active");
    tabAllImpacted.classList.remove("active");
    fetchData();
  });

  tabAllImpacted.addEventListener("click", () => {
    currentAuditTab = "all";
    tabAllImpacted.classList.add("active");
    tabActiveIncidents.classList.remove("active");
    fetchData();
  });

  document.querySelectorAll(".cluster-title-bar").forEach((bar) => {
    bar.addEventListener("click", () => {
      const targetId = bar.dataset.target;
      const grid = document.getElementById(targetId);
      const icon = bar.querySelector(".toggle-icon");
      if (grid) {
        const isHidden = grid.style.display === "none";
        grid.style.display = isHidden ? "grid" : "none";
        if (icon) icon.textContent = isHidden ? "▼ Collapse" : "▶ Expand";
      }
    });
  });

  function cleanDomainKey(key) {
    if (!key) return "UNKNOWN_DOMAIN";
    let cleaned = String(key)
      .replace(/Summary\s+of\s+Servers_?/gi, "")
      .replace(/WLS\s+Console_?/gi, "")
      .replace(/(\d{1,3}\.){3}\d{1,3}_?/g, "")
      .trim();

    cleaned = cleaned.replace(/-/g, "_").replace(/\s+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");

    if (/(CMS|GCD|ECM|NIF)/gi.test(cleaned)) {
      cleaned = cleaned.replace(/(CMS|GCD|ECM|NIF)/gi, "INTG");
    }

    if (/INTG/i.test(cleaned)) return "TCL_INTG";
    if (/LMS/i.test(cleaned)) return "TCL_LMS";
    if (/CAS/i.test(cleaned)) return "TCL_CAS";
    if (/COMMON/i.test(cleaned)) return "TCL_CommonMasters";

    if (!cleaned.startsWith("TCL_") && !cleaned.startsWith("HFL_")) {
      cleaned = "TCL_" + cleaned;
    }

    return cleaned || key;
  }

  function formatDuration(startMs, endMs) {
    if (!startMs) return "--";
    const start = (typeof startMs === "number") ? startMs : new Date(startMs).getTime();
    if (isNaN(start)) return "--";
    const finish = endMs ? ((typeof endMs === "number") ? endMs : new Date(endMs).getTime()) : Date.now();
    const diffSec = Math.max(0, Math.floor((finish - start) / 1000));
    const hrs = Math.floor(diffSec / 3600);
    const mins = Math.floor((diffSec % 3600) / 60);
    const secs = diffSec % 60;

    let timeStr = "";
    if (hrs > 0) timeStr += `${hrs}h `;
    if (mins > 0 || hrs > 0) timeStr += `${mins}m `;
    if (hrs === 0) timeStr += `${secs}s`;
    timeStr = timeStr.trim();

    return endMs
      ? `<span style="color:#60a5fa; font-weight:600;">${timeStr} (Resolved)</span>`
      : `<span style="color:#f59e0b; font-weight:700;">${timeStr} (Active)</span>`;
  }

  function getDomainOrderScore(key) {
    const k = String(key).toUpperCase();
    let groupScore = 900;
    if (k.startsWith("TCL")) groupScore = 100;
    else if (k.startsWith("HFL")) groupScore = 200;
    else if (k.startsWith("COLLECTION") || k.includes("COLL")) groupScore = 300;

    let subScore = 90;
    if (k.includes("CAS")) subScore = 10;
    else if (k.includes("LMS")) subScore = 20;
    else if (k.includes("INTG") || k.includes("CMS")) subScore = 30;
    else if (k.includes("COMMONMASTER") || k.includes("COMMON")) subScore = 40;

    return groupScore + subScore;
  }

  function sortDomainKeys(keys) {
    return keys.sort((a, b) => getDomainOrderScore(a) - getDomainOrderScore(b));
  }

  let lastAckTimestamp = 0;

  function playDashboardBeep() {
    if (isMuted || isMaintenanceMode) return;
    let repeatMin = 5;
    if (window.WLSettings) repeatMin = window.WLSettings.getAll().alertRepeatMinutes || 5;
    if (Date.now() - lastAckTimestamp < repeatMin * 60 * 1000) return;

    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "square";
      osc.frequency.setValueAtTime(880, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.15);
    } catch (e) {}
  }

  // ✅ pendingRemarks: user ka typed remark 8 seconds tak protect karta hai
  // Bina iske: user type kare, blur ho jaye, 2-sec refresh aaye → inp.value = old DB value (overwrite!)
  // Ab: type karo → 8s tak refresh kabhi override nahi karega → DB bhi update ho jaata hai
  const pendingRemarks = new Map(); // evtKey → { remark, ts }
  const REMARK_PROTECT_MS = 8000;  // 8 seconds protection after last keystroke

  const saveRemark = (e) => {
    if (e.target && e.target.classList.contains("remark-inp")) {
      const key = e.target.dataset.key;
      const val = e.target.value;
      if (key) {
        // In-memory mein track karo taaki refresh overwrite na kare
        pendingRemarks.set(key, { remark: val, ts: Date.now() });
        chrome.runtime.sendMessage({ type: "UPDATE_EVENT_REMARK", key, remark: val });
      }
    }
  };
  eventsTableBody.addEventListener("input", saveRemark);
  eventsTableBody.addEventListener("change", saveRemark);

  // ✅ 1-Click Quick Ignore button in Active Incidents audit log & Domain cards
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".quick-ignore-btn, .domain-ignore-btn");
    if (btn) {
      const nodeName = btn.dataset.node;
      const domKey = btn.dataset.domain;
      if (nodeName) {
        if (window.WLSettings) window.WLSettings.setIgnored(nodeName, true, domKey);
        chrome.runtime.sendMessage({ type: "UPDATE_IGNORE_STATE", nodeName, checked: true, domainKey: domKey });
        fetchData();
      }
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "LIVE_SYNC_TRIGGER") fetchData();
  });

  // ⚡ Instant Tab Switch Refresh: When switching back to Dashboard tab, fetch immediately!
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") fetchData();
  });
  window.addEventListener("focus", () => fetchData());

  settingsModalBtn.addEventListener("click", () => {
    loadSettingsIntoModal();
    settingsModal.classList.add("open");
  });
  closeModalBtn.addEventListener("click", () => settingsModal.classList.remove("open"));

  const cfgWebhookUrl = document.getElementById("cfgWebhookUrl");
  const cfgNonProdKeywords = document.getElementById("cfgNonProdKeywords");
  const cfgPrivacyMode = document.getElementById("cfgPrivacyMode");
  const cfgMaintenanceMode = document.getElementById("cfgMaintenanceMode");

  function loadSettingsIntoModal() {
    if (window.WLSettings) {
      const allCfg = window.WLSettings.getAll();
      cfgThreshold.value = allCfg.globalDefaultThreshold || 70;
      cfgInterval.value = allCfg.scanIntervalSeconds || 10;
      cfgAlertRepeat.value = allCfg.alertRepeatMinutes || 5;
      cfgRetention.value = allCfg.retentionDays || 7;
      cfgEnableSound.checked = allCfg.enableSound !== false;
      cfgEnableNotify.checked = allCfg.enableNotifications !== false;
      if (cfgWebhookUrl) cfgWebhookUrl.value = allCfg.webhookUrl || "";
      if (cfgNonProdKeywords) cfgNonProdKeywords.value = allCfg.nonProdKeywords || "";
      if (cfgPrivacyMode) cfgPrivacyMode.checked = allCfg.isPrivacyMode === true;
      if (cfgMaintenanceMode) cfgMaintenanceMode.checked = allCfg.isMaintenanceMode === true;
    }
  }

  saveConfigBtn.addEventListener("click", () => {
    if (window.WLSettings) {
      window.WLSettings.updateGlobalSettings({
        globalDefaultThreshold: Number(cfgThreshold.value),
        scanIntervalSeconds: Number(cfgInterval.value),
        alertRepeatMinutes: Number(cfgAlertRepeat.value),
        retentionDays: Number(cfgRetention.value),
        enableSound: cfgEnableSound.checked,
        enableNotifications: cfgEnableNotify.checked,
        webhookUrl: cfgWebhookUrl ? cfgWebhookUrl.value.trim() : "",
        nonProdKeywords: cfgNonProdKeywords ? cfgNonProdKeywords.value.trim() : "",
        isPrivacyMode: cfgPrivacyMode ? cfgPrivacyMode.checked : false,
        isMaintenanceMode: cfgMaintenanceMode ? cfgMaintenanceMode.checked : false
      });
      syncPrivacyAndMaintenanceUI();
      alert("Custom settings updated successfully!");
      settingsModal.classList.remove("open");
      fetchData();
    }
  });

  resetConfigBtn.addEventListener("click", () => {
    if (window.WLSettings && confirm("Reset custom settings to factory defaults?")) {
      window.WLSettings.reset();
      loadSettingsIntoModal();
      alert("Reset to default configuration.");
      fetchData();
    }
  });

  const privacyBtn = document.getElementById("privacyBtn");
  const maintenanceBtn = document.getElementById("maintenanceBtn");

  let isPrivacyMode = false;
  let isMaintenanceMode = false;

  function maskIP(str) {
    if (!str) return "";
    if (!isPrivacyMode) return str;
    return String(str).replace(/(\d{1,3}\.){3}\d{1,3}/g, "10.0.X.X");
  }

  function syncPrivacyAndMaintenanceUI() {
    if (window.WLSettings) {
      const allCfg = window.WLSettings.getAll();
      isPrivacyMode = allCfg.isPrivacyMode === true;
      isMaintenanceMode = allCfg.isMaintenanceMode === true;
      isMuted = allCfg.enableSound === false;
    }
    if (muteBtn) {
      muteBtn.textContent = isMuted ? "🔇 Audio Alerts OFF" : "🔈 Audio Alerts ON";
      muteBtn.style.background = isMuted ? "rgba(239, 68, 68, 0.3)" : "rgba(255, 255, 255, 0.08)";
      muteBtn.style.borderColor = isMuted ? "rgba(239, 68, 68, 0.6)" : "var(--border)";
    }
    if (privacyBtn) {
      privacyBtn.textContent = isPrivacyMode ? "🙈 Privacy Mode: ON" : "🙈 Privacy Mode: OFF";
      privacyBtn.style.background = isPrivacyMode ? "rgba(139, 92, 246, 0.3)" : "rgba(255, 255, 255, 0.08)";
      privacyBtn.style.borderColor = isPrivacyMode ? "rgba(139, 92, 246, 0.6)" : "var(--border)";
    }
    if (maintenanceBtn) {
      maintenanceBtn.textContent = isMaintenanceMode ? "📅 Maintenance: ON" : "📅 Maintenance: OFF";
      maintenanceBtn.style.background = isMaintenanceMode ? "rgba(245, 158, 11, 0.3)" : "rgba(255, 255, 255, 0.08)";
      maintenanceBtn.style.borderColor = isMaintenanceMode ? "rgba(245, 158, 11, 0.6)" : "var(--border)";
    }
  }

  syncPrivacyAndMaintenanceUI();

  if (privacyBtn) {
    privacyBtn.addEventListener("click", () => {
      isPrivacyMode = !isPrivacyMode;
      if (window.WLSettings) window.WLSettings.updateGlobalSettings({ isPrivacyMode });
      syncPrivacyAndMaintenanceUI();
      fetchData();
    });
  }

  if (maintenanceBtn) {
    maintenanceBtn.addEventListener("click", () => {
      isMaintenanceMode = !isMaintenanceMode;
      if (window.WLSettings) window.WLSettings.updateGlobalSettings({ isMaintenanceMode });
      syncPrivacyAndMaintenanceUI();
      fetchData();
    });
  }

  if (muteBtn) {
    muteBtn.addEventListener("click", () => {
      isMuted = !isMuted;
      if (window.WLSettings) window.WLSettings.updateGlobalSettings({ enableSound: !isMuted });
      syncPrivacyAndMaintenanceUI();
    });
  }

  if (exportTodayBtn) {
    exportTodayBtn.addEventListener("click", () => exportCSV(true));
  }
  if (exportAllBtn) {
    exportAllBtn.addEventListener("click", () => exportCSV(false));
  }

  if (globalAckBtn) {
    globalAckBtn.addEventListener("click", () => {
      lastAckTimestamp = Date.now();
      try {
        chrome.storage.local.set({ "globalAckTimestamp": lastAckTimestamp });
        if (chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ type: "ACK_ALL_ALERTS" });
        }
      } catch (e) {}
      updateAckUI();
    });
  }

  function updateAckUI() {
    if (!globalAckBtn) return;

    let repeatMin = 5;
    if (window.WLSettings) repeatMin = window.WLSettings.getAll().alertRepeatMinutes || 5;
    const ackDurationMs = repeatMin * 60 * 1000;
    const elapsed = Date.now() - lastAckTimestamp;

    if (lastAckTimestamp > 0 && elapsed < ackDurationMs) {
      const remainingSec = Math.ceil((ackDurationMs - elapsed) / 1000);
      const remainingMin = Math.floor(remainingSec / 60);
      const remSecSec = remainingSec % 60;
      const displayStr = remainingMin > 0 ? `${remainingMin}m ${remSecSec}s` : `${remainingSec}s`;

      globalAckBtn.textContent = `✅ Alerts ACKed (${displayStr} Muted)`;
      globalAckBtn.style.background = "rgba(16, 185, 129, 0.3)";
      globalAckBtn.style.borderColor = "rgba(16, 185, 129, 0.6)";
    } else {
      globalAckBtn.textContent = "✅ Global ACK All";
      globalAckBtn.style.background = "rgba(255, 255, 255, 0.08)";
      globalAckBtn.style.borderColor = "var(--border)";
    }
  }

  try {
    chrome.storage.local.get(["globalAckTimestamp"], (res) => {
      if (res && typeof res.globalAckTimestamp === "number") {
        lastAckTimestamp = res.globalAckTimestamp;
        updateAckUI();
      }
    });
  } catch (e) {}

  try {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg) {
          fetchData();
        }
      });
    }
  } catch (e) {}

  function fetchData() {
    syncPrivacyAndMaintenanceUI();

    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: "GET_GLOBAL_STATS" }, (globalStats) => {
          const stats = globalStats || { domains: {} };
          chrome.runtime.sendMessage({ type: "GET_GLOBAL_EVENTS" }, (allEvents) => {
            renderDashboardGrid(stats, Array.isArray(allEvents) ? allEvents : []);
          });
        });
      }
    } catch (e) {}
  }

  function renderDashboardGrid(globalStats, allEvents) {
    try {
      // === DOMAIN GRID RENDERING ===
      const rawDomainsMap = globalStats.domains || {};
      const rawDomainKeys = Object.keys(rawDomainsMap);

      const domainsMap = {};
      rawDomainKeys.forEach(rk => {
        const ck = cleanDomainKey(rk);
        if (!domainsMap[ck]) {
          domainsMap[ck] = rawDomainsMap[rk];
          domainsMap[ck].domainKey = ck;
        } else {
          domainsMap[ck].nodes = { ...domainsMap[ck].nodes, ...rawDomainsMap[rk].nodes };
        }
      });

      const domainKeys = sortDomainKeys(Object.keys(domainsMap));

      let totalCritical = 0;
      let totalWarning = 0;
      let totalHealthy = 0;
      let hasActiveAlerts = false;

      const unreachableBannerHtml = `<div style="padding: 24px; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.4); border-radius: 12px; color: #fca5a5; font-size: 18px; font-weight: 700; text-align: center; margin: 20px 0;">⚠️ WebLogic Unreachable - Network Disconnected<div style="font-size: 13px; font-weight: 500; color: #94a3b8; margin-top: 8px;">Please check network connectivity to WebLogic Admin Servers.</div></div>`;

      if (domainKeys.length === 0) {
        tclCluster.style.display = "none";
        hflCluster.style.display = "none";
        collCluster.style.display = "none";
        ignoredCluster.style.display = "none";
        noDomainsPlaceholder.style.display = "block";
        noDomainsPlaceholder.innerHTML = unreachableBannerHtml;
        updateKPIs(0, 0, 0, 0);
        renderAuditTable(globalStats, allEvents);
        return;
      }

      noDomainsPlaceholder.style.display = "none";

      document.querySelectorAll(".domain-card").forEach(card => {
        const cardDomain = card.dataset.domain;
        if (!domainKeys.includes(cardDomain) && cardDomain !== "IGNORED_REGISTRY") card.remove();
      });

      let hasTCL = false, hasHFL = false, hasCOLL = false;
      const ignoredNodesList = [];

      domainKeys.forEach((key) => {
        const domainObj = domainsMap[key];
        const nodes = domainObj.nodes || {};
        const nodeNames = Object.keys(nodes);

        if (searchTerm && !key.toLowerCase().includes(searchTerm) && !nodeNames.some(n => n.toLowerCase().includes(searchTerm))) return;

        let dCritical = 0;
        let dWarning = 0;

        const activeNodeNames = nodeNames.filter(nName => {
          const isIgn = window.WLSettings ? window.WLSettings.isIgnored(nName, key) : false;
          if (isIgn) {
            ignoredNodesList.push({ nodeName: nName, domainKey: key });
            return false;
          }
          return true;
        });

        if (activeNodeNames.length === 0 && !domainObj.unreachable) {
          const card = document.querySelector(`.domain-card[data-domain="${key}"]`);
          if (card) card.remove();
          return;
        }

        const kUpper = key.toUpperCase();
        let targetGrid = collGrid;
        if (kUpper.startsWith("TCL")) { targetGrid = tclGrid; hasTCL = true; }
        else if (kUpper.startsWith("HFL")) { targetGrid = hflGrid; hasHFL = true; }
        else hasCOLL = true;

        let domainCard = document.querySelector(`.domain-card[data-domain="${key}"]`);

        const nowMs = Date.now();
        // ⚡ ACTIVE SYNC TIMESTAMP: Measures keep-alive heartbeat freshness from active WebLogic tabs
        const lastScanMs = domainObj.lastScanTime || domainObj.lastUpdated || nowMs;
        const elapsedSec = Math.floor((nowMs - lastScanMs) / 1000);
        const consoleTimeStr = domainObj.consoleLastRefreshed || "";

        let hbBadgeHtml = "";
        if (domainObj.unreachable) {
          hbBadgeHtml = `<span class="hb-badge unreachable" style="padding:3px 8px;font-size:10px;font-weight:700;border-radius:12px;background:rgba(239,68,68,0.3);color:#fca5a5;border:1px solid #ef4444;" title="Network Disconnected / Server Unreachable">📡 NETWORK DISCONNECTED / UNREACHABLE</span>`;
        } else if (domainObj.isLoggedOut) {
          hbBadgeHtml = `<span class="hb-badge expired" style="padding:3px 8px;font-size:10px;font-weight:700;border-radius:12px;background:rgba(239,68,68,0.2);color:#fca5a5;border:1px solid rgba(239,68,68,0.4);" title="WebLogic Console Session Logged Out">🔑 EXPIRED</span>`;
        } else if (elapsedSec < 45) {
          hbBadgeHtml = `<span class="hb-badge live" style="padding:3px 8px;font-size:10px;font-weight:700;border-radius:12px;background:rgba(34,197,94,0.2);color:#4ade80;border:1px solid rgba(34,197,94,0.4);" title="${consoleTimeStr}">🟢 LIVE (${elapsedSec}s ago)</span>`;
        } else if (elapsedSec < 180) {
          hbBadgeHtml = `<span class="hb-badge idle" style="padding:3px 8px;font-size:10px;font-weight:700;border-radius:12px;background:rgba(245,158,11,0.2);color:#fbbf24;border:1px solid rgba(245,158,11,0.4);" title="${consoleTimeStr}">🟡 IDLE (${elapsedSec}s ago)</span>`;
        } else {
          hbBadgeHtml = `<button class="hb-badge frozen wake-tab-btn" data-domain="${key}" style="padding:3px 8px;font-size:10px;font-weight:700;border-radius:12px;background:rgba(239,68,68,0.3);color:#fff;border:1px solid #ef4444;cursor:pointer;" title="Click to wake tab and refresh WebLogic wheel">🔴 FROZEN (${Math.floor(elapsedSec / 60)}m ago) ⚡ Wake</button>`;
        }

        if (!domainCard) {
          domainCard = document.createElement("div");
          domainCard.className = "domain-card";
          domainCard.dataset.domain = key;
          domainCard.innerHTML = `
            <div class="domain-card-header">
              <div class="domain-card-title">
                <h3>${key}</h3>
                <span class="server-count-tag">${activeNodeNames.length} Active Servers</span>
              </div>
              <div style="display:flex;align-items:center;gap:6px;">
                <div class="hb-wrapper">${hbBadgeHtml}</div>
                <span class="status-pill healthy">HEALTHY</span>
              </div>
            </div>
            <div class="node-table-wrapper">
              <table class="node-table">
                <thead>
                  <tr>
                    <th>Server Name</th><th>State</th><th>Health</th><th>Sockets</th>
                    <th style="text-align:right;">Status</th>
                  </tr>
                </thead>
                <tbody class="node-table-body"></tbody>
              </table>
            </div>
            <div style="display:flex; gap:8px; margin-top:12px;">
              <button class="btn export-all-domain-btn" style="flex:1;justify-content:center;padding:7px 10px;font-size:12px;font-weight:600;">📥 Export All CSV</button>
              <button class="btn btn-primary switch-btn" style="flex:1;justify-content:center;padding:7px 10px;font-size:12px;font-weight:600;">🔗 Switch Tab</button>
            </div>
          `;
          const expDomainBtn = domainCard.querySelector(".export-all-domain-btn");
          if (expDomainBtn) expDomainBtn.addEventListener("click", () => exportNodeSpecificCSV(key, false));
          const switchBtn = domainCard.querySelector(".switch-btn");
          if (switchBtn) {
            switchBtn.addEventListener("click", () => {
              if (domainObj.tabId) chrome.runtime.sendMessage({ type: "SWITCH_TO_TAB", tabId: domainObj.tabId });
              else if (domainObj.url) chrome.runtime.sendMessage({ type: "SWITCH_TO_TAB", url: domainObj.url });
            });
          }
          targetGrid.appendChild(domainCard);
        } else {
          const titleH3 = domainCard.querySelector(".domain-card-title h3");
          if (titleH3 && titleH3.textContent !== key) titleH3.textContent = key;
          const countTag = domainCard.querySelector(".server-count-tag");
          if (countTag) countTag.textContent = `${activeNodeNames.length} Active Servers`;
          const hbWrapper = domainCard.querySelector(".hb-wrapper");
          if (hbWrapper) hbWrapper.innerHTML = hbBadgeHtml;
          if (domainCard.parentElement !== targetGrid) targetGrid.appendChild(domainCard);
        }

        const wakeBtn = domainCard.querySelector(".wake-tab-btn");
        if (wakeBtn) {
          wakeBtn.onclick = (e) => {
            e.stopPropagation();
            if (domainObj.tabId) chrome.runtime.sendMessage({ type: "SWITCH_TO_TAB", tabId: domainObj.tabId });
            else if (domainObj.url) chrome.runtime.sendMessage({ type: "SWITCH_TO_TAB", url: domainObj.url });
          };
        }

        const tbody = domainCard.querySelector(".node-table-body");
        tbody.querySelectorAll("tr").forEach(tr => { if (!activeNodeNames.includes(tr.dataset.node)) tr.remove(); });

        activeNodeNames.forEach((nName) => {
          const node = nodes[nName];
          let badgeClass = "normal";
          let displaySeverity = node.severity || "NORMAL";

          if (node.severity === "CRITICAL") { dCritical++; hasActiveAlerts = true; badgeClass = "critical"; }
          else if (node.severity === "WARNING") { dWarning++; hasActiveAlerts = true; badgeClass = "warning"; }

          let row = Array.from(tbody.children).find(tr => tr.dataset && tr.dataset.node === node.name);
          if (!row) {
            row = document.createElement("tr");
            row.dataset.node = node.name;
            row.innerHTML = `
              <td class="node-name" title="${node.name}">${maskIP(node.name)}</td>
              <td class="col-state">${node.state || "RUNNING"}</td>
              <td class="col-health">${node.health || "OK"}</td>
              <td class="col-sockets" style="font-weight:700;color:#f8fafc;">${node.sockets || 0}</td>
              <td style="text-align:right;"><span class="badge-tag ${badgeClass}">${displaySeverity}</span></td>
            `;
            tbody.appendChild(row);
          } else {
            const nodeTd = row.querySelector(".node-name");
            const masked = maskIP(node.name);
            if (nodeTd && nodeTd.textContent !== masked) nodeTd.textContent = masked;
            const colState = row.querySelector(".col-state");
            if (colState && colState.textContent !== (node.state || "RUNNING")) colState.textContent = node.state || "RUNNING";
            const colHealth = row.querySelector(".col-health");
            if (colHealth && colHealth.textContent !== (node.health || "OK")) colHealth.textContent = node.health || "OK";
            const colSockets = row.querySelector(".col-sockets");
            const socketVal = String(node.sockets || 0);
            if (colSockets && colSockets.textContent !== socketVal) colSockets.textContent = socketVal;
            const tag = row.querySelector(".badge-tag");
            if (tag) {
              if (tag.className !== `badge-tag ${badgeClass}`) tag.className = `badge-tag ${badgeClass}`;
              if (tag.textContent !== displaySeverity) tag.textContent = displaySeverity;
            }
          }
        });

        if (domainObj.unreachable) {
          // 📡 Network Disconnection is NOT a WebLogic server critical breach! Do not inflate Critical Alerts count or sound sirens!
        } else if (dCritical > 0) totalCritical++;
        else if (dWarning > 0) totalWarning++;
        else totalHealthy++;

        const statusPill = domainCard.querySelector(".status-pill");
        if (statusPill) {
          if (domainObj.unreachable) { statusPill.className = "status-pill critical"; statusPill.textContent = "UNREACHABLE"; }
          else if (dCritical > 0) { statusPill.className = "status-pill critical"; statusPill.textContent = `${dCritical} CRITICAL`; }
          else if (dWarning > 0) { statusPill.className = "status-pill warning"; statusPill.textContent = `${dWarning} WARNING`; }
          else { statusPill.className = "status-pill healthy"; statusPill.textContent = "HEALTHY"; }
        }
      });

      // 🚫 Ignored Servers Registry
      if (ignoredNodesList.length > 0) {
        ignoredCluster.style.display = "block";
        let ignCard = document.querySelector(`.domain-card[data-domain="IGNORED_REGISTRY"]`);
        if (!ignCard) {
          ignCard = document.createElement("div");
          ignCard.className = "domain-card";
          ignCard.dataset.domain = "IGNORED_REGISTRY";
          ignCard.style.cssText = "grid-column:1/-1;background:rgba(15,23,42,0.8);border:1px solid rgba(148,163,184,0.3);";
          ignCard.innerHTML = `
            <div class="domain-card-header">
              <div class="domain-card-title">
                <h3 style="color:#cbd5e1;">🚫 Ignored & Muted Servers Registry</h3>
                <span class="server-count-tag" id="ignCountTag">${ignoredNodesList.length} Ignored Shutdown Servers</span>
              </div>
              <span class="status-pill" style="background:rgba(148,163,184,0.2);color:#cbd5e1;border:1px solid rgba(148,163,184,0.4);">MUTED</span>
            </div>
            <table class="data-table" style="font-size:11px;margin-top:8px;">
              <thead>
                <tr><th>Domain</th><th>Server Name</th><th>State</th><th>Health</th><th>Sockets</th><th>Status</th><th style="text-align:right;">Action</th></tr>
              </thead>
              <tbody id="ignoredTableBody"></tbody>
            </table>
          `;
          ignoredGrid.appendChild(ignCard);
        } else {
          const countTag = ignCard.querySelector("#ignCountTag");
          if (countTag) countTag.textContent = `${ignoredNodesList.length} Ignored Shutdown Servers`;
        }

        const ignTbody = ignCard.querySelector("#ignoredTableBody");
        ignTbody.innerHTML = "";
        ignoredNodesList.forEach(item => {
          const n = item.node;
          const tr = document.createElement("tr");
          tr.innerHTML = `
            <td><strong>${item.domainKey}</strong></td>
            <td style="font-weight:600;color:#fff;">${item.nodeName}</td>
            <td>SHUTDOWN</td>
            <td>Not reachable</td>
            <td>0</td>
            <td><span class="badge-tag ignored">IGNORED</span></td>
            <td style="text-align:right;">
              <button class="btn unignore-btn" data-node="${item.nodeName}" data-domain="${item.domainKey}" style="padding:3px 8px;font-size:10px;background:rgba(16,185,129,0.2);color:#6ee7b7;border:1px solid rgba(16,185,129,0.4);">
                🔓 Un-Ignore
              </button>
            </td>
          `;
          ignTbody.appendChild(tr);
        });

        ignTbody.querySelectorAll(".unignore-btn").forEach(btn => {
          btn.addEventListener("click", () => {
            const nodeName = btn.dataset.node;
            const domKey = btn.dataset.domain;
            if (nodeName) {
              if (window.WLSettings) window.WLSettings.setIgnored(nodeName, false, domKey);
              chrome.runtime.sendMessage({ type: "UPDATE_IGNORE_STATE", nodeName, checked: false, domainKey: domKey });
              fetchData();
            }
          });
        });
      } else {
        ignoredCluster.style.display = "none";
      }

      tclCluster.style.display = hasTCL ? "block" : "none";
      hflCluster.style.display = hasHFL ? "block" : "none";
      collCluster.style.display = hasCOLL ? "block" : "none";

      updateKPIs(totalCritical, totalWarning, totalHealthy, domainKeys.length);

      // Auto-reset ACK button when all servers return to normal (0 active warnings)
      if (totalCritical === 0 && totalWarning === 0 && lastAckTimestamp > 0) {
        lastAckTimestamp = 0;
        try { chrome.storage.local.set({ "globalAckTimestamp": 0 }); } catch (e) {}
        updateAckUI();
      }
      if (hasActiveAlerts) playDashboardBeep();

      renderAuditTable(globalStats, allEvents);
    } catch (e) {
      releaseFetchLock();
    }
  }

  // ✅ FIX 7: Audit table rendering separated — uses pre-fetched globalStats
  function renderAuditTable(globalStats, allEvents) {
    try {
      if (!allEvents || !Array.isArray(allEvents)) allEvents = [];
      const genuineEvents = allEvents.filter(e => e.severity !== "IGNORED");

      if (currentAuditTab === "active") {
        const activeMapNodes = [];
        if (globalStats && globalStats.domains) {
          Object.values(globalStats.domains).forEach(domObj => {
            const domKey = cleanDomainKey(domObj.domainKey || "");
            if (domObj.nodes) {
              Object.values(domObj.nodes).forEach(n => {
                if ((n.severity === "CRITICAL" || n.severity === "WARNING") && (!window.WLSettings || !window.WLSettings.isIgnored(n.name, domKey))) {
                  activeMapNodes.push({
                    incidentId: `${domKey}_${n.name}`,
                    key: `${domKey}_${n.name}`,
                    node: n.name,
                    domain: domKey,
                    severity: n.severity,
                    health: n.health || "OK",
                    sockets: n.sockets || 0,
                    state: n.state || "RUNNING",
                    stuckThreads: n.stuckThreads || "",
                    startTime: n.startTime || Date.now(),
                    startDisplay: n.startDisplay || new Date().toLocaleString(),
                    endTime: null,
                    endDisplay: null,
                    remark: n.remark || ""
                  });
                }
              });
            }
          });
        }

        const dbActive = (globalStats && globalStats.impactedList)
          ? globalStats.impactedList.filter(e => {
              if (window.WLSettings && window.WLSettings.isIgnored(e.node, e.domain)) return false;
              return e.severity !== "IGNORED" && e.severity !== "NORMAL";
            })
          : [];

        const mergedActive = new Map();
        [...activeMapNodes, ...dbActive].forEach(item => {
          const k = `${cleanDomainKey(item.domain)}_${item.node}`;
          if (!mergedActive.has(k)) {
            mergedActive.set(k, item);
          } else {
            const existing = mergedActive.get(k);
            const exStart = existing.startTime ? new Date(existing.startTime).getTime() : Date.now();
            const itemStart = item.startTime ? new Date(item.startTime).getTime() : Date.now();
            if (itemStart < exStart) {
              mergedActive.set(k, item);
            }
          }
        });

        const impactedList = Array.from(mergedActive.values());

        if (impactedList.length === 0) {
          eventsTableBody.innerHTML = `<tr><td colspan="10" class="empty-placeholder">🎉 No active incident alerts right now. All domains healthy!</td></tr>`;
          releaseFetchLock(); // Release after empty check
          return;
        }

        eventsTableBody.querySelectorAll("tr").forEach(tr => {
          if (tr.dataset.evtKey) {
            const match = impactedList.find(e => (e.incidentId || e.key || `${e.domain}_${e.node}`) === tr.dataset.evtKey);
            if (!match) tr.remove();
          }
        });

        impactedList.forEach((evt) => {
          const evtKey = evt.incidentId || evt.key || `${evt.domain}_${evt.node}`;
          const badgeClass = evt.severity === "CRITICAL" ? "critical" : "warning";
          const currentRemark = evt.remark || evt.stuckThreads || "";
          const startTimeMs = evt.startTime ? new Date(evt.startTime).getTime() : new Date(evt.time).getTime();
          const startDisplay = evt.startDisplay || new Date(startTimeMs).toLocaleString();
          const durationHtml = formatDuration(startTimeMs, null);

          let tr = Array.from(eventsTableBody.children).find(row => row.dataset && row.dataset.evtKey === evtKey);
          if (!tr) {
            tr = document.createElement("tr");
            tr.dataset.evtKey = evtKey;
            tr.innerHTML = `
              <td>${startDisplay}</td>
              <td><span style="color:#f59e0b;font-weight:600;">Active Alert</span></td>
              <td><strong>${cleanDomainKey(evt.domain || "DEFAULT")}</strong></td>
              <td style="font-weight:600;color:#fff;">${maskIP(evt.node)}</td>
              <td><span class="badge-tag ${badgeClass}">${evt.severity}</span></td>
              <td class="col-health">${evt.health || "OK"}</td>
              <td class="col-sockets" style="font-weight:700;color:#f8fafc;">${evt.sockets || 0}</td>
              <td class="col-state">${evt.state || "RUNNING"}</td>
              <td class="col-duration">${durationHtml}</td>
              <td>
                <div style="display:flex;gap:6px;align-items:center;">
                  <input type="text" class="remark-inp" data-key="${evtKey}" value="${currentRemark}" placeholder="+ Add Stuck/Remark" style="background:rgba(15,23,42,0.8);border:1px solid rgba(255,255,255,0.18);color:#f8fafc;padding:5px 8px;border-radius:6px;font-size:11px;flex:1;outline:none;">
                  <button class="btn quick-ignore-btn" data-node="${evt.node}" data-domain="${evt.domain}" style="padding:4px 8px;font-size:10px;background:rgba(239,68,68,0.2);color:#fca5a5;border:1px solid rgba(239,68,68,0.4);border-radius:6px;cursor:pointer;white-space:nowrap;" title="Ignore server ${evt.node}">🚫 Ignore</button>
                </div>
              </td>
            `;
            eventsTableBody.appendChild(tr);
          } else {
            const nodeTd = tr.children[3];
            const masked = maskIP(evt.node);
            if (nodeTd && nodeTd.textContent !== masked) nodeTd.textContent = masked;
            const colSockets = tr.querySelector(".col-sockets");
            if (colSockets && colSockets.textContent !== String(evt.sockets || 0)) colSockets.textContent = String(evt.sockets || 0);
            const colHealth = tr.querySelector(".col-health");
            if (colHealth && colHealth.textContent !== (evt.health || "OK")) colHealth.textContent = evt.health || "OK";
            const colState = tr.querySelector(".col-state");
            if (colState && colState.textContent !== (evt.state || "RUNNING")) colState.textContent = evt.state || "RUNNING";
            const colDuration = tr.querySelector(".col-duration");
            if (colDuration) colDuration.innerHTML = durationHtml;
            const inp = tr.querySelector(".remark-inp");
            if (inp) {
              const pending = pendingRemarks.get(evtKey);
              if (pending && (Date.now() - pending.ts < REMARK_PROTECT_MS)) {
                // ✅ User ne recently type kiya — 8s tak refresh override nahi karega
                if (inp.value !== pending.remark) inp.value = pending.remark;
              } else {
                pendingRemarks.delete(evtKey); // stale entry cleanup
                if (document.activeElement !== inp && inp.value !== currentRemark) inp.value = currentRemark;
              }
            }
          }
        });

        releaseFetchLock(); // Release after active tab rendered

      } else {
        // 📋 All Impacted Events (100% Preserved Historical Incidents)
        let genuineEvents = allEvents.filter(e => {
          if (window.WLSettings && window.WLSettings.isIgnored(e.node, e.domain)) return false;
          if (e.severity === "IGNORED") return false;
          return true;
        });

        // 🌟 FAILSAFE AUTO-FALLBACK: If DB was newly initialized/reset, auto-include active warnings from domainStateMap
        if (genuineEvents.length === 0 && globalStats && globalStats.domains) {
          Object.values(globalStats.domains).forEach(domObj => {
            const domKey = cleanDomainKey(domObj.domainKey || "");
            if (domObj.nodes) {
              Object.values(domObj.nodes).forEach(n => {
                if ((n.severity === "CRITICAL" || n.severity === "WARNING") && (!window.WLSettings || !window.WLSettings.isIgnored(n.name, domKey))) {
                  genuineEvents.push({
                    incidentId: `${domKey}_${n.name}`,
                    key: `${domKey}_${n.name}`,
                    node: n.name,
                    domain: domKey,
                    severity: n.severity,
                    health: n.health || "OK",
                    sockets: n.sockets || 0,
                    state: n.state || "RUNNING",
                    stuckThreads: n.stuckThreads || "",
                    startTime: n.startTime || Date.now(),
                    startDisplay: n.startDisplay || new Date().toLocaleString(),
                    endTime: null,
                    endDisplay: null,
                    remark: n.remark || ""
                  });
                }
              });
            }
          });
        }

        // Empty check after filter
        if (genuineEvents.length === 0) {
          eventsTableBody.innerHTML = `<tr><td colspan="10" class="empty-placeholder">No historical impacted events logged yet.</td></tr>`;
          releaseFetchLock();
          return;
        }

        // ✅ Sort by Start Time Descending — latest incident sabse upar
        const topEvents = genuineEvents
          .sort((a, b) => {
            const aMs = a.startTime ? new Date(a.startTime).getTime() : new Date(a.time).getTime();
            const bMs = b.startTime ? new Date(b.startTime).getTime() : new Date(b.time).getTime();
            return bMs - aMs; // desc: latest first
          })
          .slice(0, 100);

        eventsTableBody.querySelectorAll("tr").forEach(tr => {
          if (tr.dataset.evtKey) {
            const match = topEvents.find(e => (e.incidentId || e.id || e.key || `${e.domain}_${e.node}_${e.time}`) === tr.dataset.evtKey);
            if (!match) tr.remove();
          }
        });

        topEvents.forEach((evt) => {
          const evtKey = evt.incidentId || evt.id || evt.key || `${evt.domain}_${evt.node}_${evt.time}`;
          const isOutageSeverity = evt.outageSeverity || (evt.severity !== "RECOVERED" ? evt.severity : "WARNING");
          const badgeClass = isOutageSeverity === "CRITICAL" ? "critical" : "warning";
          const currentRemark = evt.remark || evt.stuckThreads || "";
          const startTimeMs = evt.startTime ? new Date(evt.startTime).getTime() : new Date(evt.time).getTime();
          const endTimeMs = evt.endTime ? new Date(evt.endTime).getTime() : null;
          const startDisplay = evt.startDisplay || new Date(startTimeMs).toLocaleString();
          const recoveryDisplay = evt.endDisplay || (endTimeMs ? new Date(endTimeMs).toLocaleString() : `<span style="color:#f59e0b;font-weight:600;">Active Alert</span>`);
          const durationHtml = formatDuration(startTimeMs, endTimeMs);

          let tr = Array.from(eventsTableBody.children).find(row => row.dataset && row.dataset.evtKey === evtKey);
          if (!tr) {
            tr = document.createElement("tr");
            tr.dataset.evtKey = evtKey;
            tr.innerHTML = `
              <td>${startDisplay}</td>
              <td>${recoveryDisplay}</td>
              <td><strong>${cleanDomainKey(evt.domain || "DEFAULT")}</strong></td>
              <td style="font-weight:600;color:#fff;">${maskIP(evt.node)}</td>
              <td><span class="badge-tag ${badgeClass}">${isOutageSeverity}</span></td>
              <td>${evt.health || "OK"}</td>
              <td style="font-weight:700;color:#f8fafc;">${evt.sockets || 0}</td>
              <td>${evt.state || "RUNNING"}</td>
              <td>${durationHtml}</td>
              <td><input type="text" class="remark-inp" data-key="${evtKey}" value="${currentRemark}" placeholder="+ Add Stuck/Remark" style="background:rgba(15,23,42,0.8);border:1px solid rgba(255,255,255,0.18);color:#f8fafc;padding:5px 10px;border-radius:6px;font-size:11px;width:100%;min-width:130px;outline:none;"></td>
            `;
            eventsTableBody.appendChild(tr);
          } else {
            const nodeTd = tr.children[3];
            const masked = maskIP(evt.node);
            if (nodeTd && nodeTd.textContent !== masked) nodeTd.textContent = masked;
            const inp = tr.querySelector(".remark-inp");
            if (inp) {
              const pending = pendingRemarks.get(evtKey);
              if (pending && (Date.now() - pending.ts < REMARK_PROTECT_MS)) {
                // ✅ User ne recently type kiya — 8s tak refresh override nahi karega
                if (inp.value !== pending.remark) inp.value = pending.remark;
              } else {
                pendingRemarks.delete(evtKey); // stale entry cleanup
                if (document.activeElement !== inp && inp.value !== currentRemark) inp.value = currentRemark;
              }
            }
          }
        });

        releaseFetchLock(); // Release after all-impacted tab rendered
      }
    } catch (e) {
      releaseFetchLock();
    }
  }

  let lastDashboardBeepTime = 0;
  const BEEP_REPEAT_COOLDOWN_MS = 60 * 1000; // 60-second cooldown between repeat beeps

  function playDashboardBeep() {
    let repeatMin = 5;
    if (window.WLSettings) repeatMin = window.WLSettings.getAll().alertRepeatMinutes || 5;
    const ackDurationMs = repeatMin * 60 * 1000;
    const elapsed = Date.now() - lastAckTimestamp;

    if (isMuted || isMaintenanceMode || (lastAckTimestamp > 0 && elapsed < ackDurationMs)) return;

    const now = Date.now();
    // 🛡️ REPEAT BEEP COOLDOWN: Mute continuous 1-second beeping! Only beep once every 60 seconds max.
    if (now - lastDashboardBeepTime < BEEP_REPEAT_COOLDOWN_MS) {
      return;
    }

    try {
      if (chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(["lastGlobalSoundPlayedTimestamp"], (res) => {
          const lastPlayed = (res && res.lastGlobalSoundPlayedTimestamp) || 0;

          // 🔒 3-SECOND GLOBAL CHROME STORAGE AUDIO LOCK ACROSS ALL TABS & DASHBOARDS
          if (now - lastPlayed < 3000) {
            return;
          }

          lastDashboardBeepTime = now;
          chrome.storage.local.set({ "lastGlobalSoundPlayedTimestamp": now });
          triggerDashboardBeep();
        });
      } else {
        lastDashboardBeepTime = now;
        triggerDashboardBeep();
      }
    } catch (e) {
      lastDashboardBeepTime = now;
      triggerDashboardBeep();
    }
  }

  function triggerDashboardBeep() {
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtx.state === "suspended") {
        audioCtx.resume();
      }
      let t = audioCtx.currentTime;
      for (let n = 0; n < 3; n++) {
        let osc = audioCtx.createOscillator();
        let gain = audioCtx.createGain();
        osc.type = "square";
        osc.frequency.value = 500;
        gain.gain.value = 0.3;
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + 0.25);
        t += 0.4;
      }
    } catch (e) {}
  }

  function updateKPIs(crit, warn, healthy, tabs) {
    if (kpiCritical.textContent !== String(crit)) kpiCritical.textContent = String(crit);
    if (kpiWarning.textContent !== String(warn)) kpiWarning.textContent = String(warn);
    if (kpiHealthy.textContent !== String(healthy)) kpiHealthy.textContent = String(healthy);
    if (kpiTabs.textContent !== String(tabs)) kpiTabs.textContent = String(tabs);
  }

  const safeCSV = str => '"' + String(str || '').replace(/"/g, '""') + '"';

  function buildCSVRow(item, index) {
    const startMs = item.startTime ? new Date(item.startTime).getTime() : new Date(item.time).getTime();
    const endMs = item.endTime ? new Date(item.endTime).getTime() : null;
    const diffSec = Math.max(0, Math.floor(((endMs || Date.now()) - startMs) / 1000));
    const hrs = Math.floor(diffSec / 3600);
    const mins = Math.floor((diffSec % 3600) / 60);
    const secs = diffSec % 60;
    let durStr = "";
    if (hrs > 0) durStr += `${hrs}h `;
    if (mins > 0 || hrs > 0) durStr += `${mins}m `;
    durStr += `${secs}s`;
    const durationFormatted = endMs ? `${durStr} (Resolved)` : `${durStr} (Active)`;
    const outSev = item.outageSeverity || item.severity;

    return [
      index + 1,
      safeCSV(new Date(startMs).toLocaleString()),
      safeCSV(endMs ? new Date(endMs).toLocaleString() : 'Active Alert'),
      safeCSV(cleanDomainKey(item.domain || '')),
      safeCSV(item.node || ''),
      safeCSV(item.health || ''),
      item.sockets || 0,
      safeCSV(item.state || ''),
      safeCSV(outSev),
      safeCSV(durationFormatted),
      safeCSV(item.stuckThreads || item.remark || '')
    ].join(",") + "\n";
  }

  function exportNodeSpecificCSV(domainKey, todayOnly) {
    chrome.runtime.sendMessage({ type: "GET_GLOBAL_EVENTS" }, (events) => {
      if (!events || !events.length) { alert(`No audit logs recorded for domain ${domainKey}.`); return; }
      const todayStr = new Date().toLocaleDateString();
      const filtered = events.filter(item => {
        if (item.severity === "IGNORED") return false;
        const itemDom = cleanDomainKey(item.domain || "");
        if (itemDom !== domainKey && item.domain !== domainKey) return false;
        if (todayOnly && new Date(item.time).toLocaleDateString() !== todayStr) return false;
        return true;
      });
      if (!filtered.length) { alert(`No audit logs recorded for ${domainKey}.`); return; }
      let csv = "\uFEFFID,Start Time,Recovery Time,Domain,Node,Health,Sockets,State,Outage Severity,Impact Duration,Remark\n";
      filtered.forEach((item, i) => { csv += buildCSVRow(item, i); });
      downloadCSV(csv, `WLMonitor_${domainKey}_ImpactReport_${new Date().toISOString().split("T")[0]}.csv`);
    });
  }

  function exportCSV(todayOnly) {
    chrome.runtime.sendMessage({ type: "GET_GLOBAL_EVENTS" }, (events) => {
      if (!events || !events.length) { alert("No event data available to export."); return; }
      const todayStr = new Date().toLocaleDateString();
      let csv = "\uFEFFID,Start Time,Recovery Time,Domain,Node,Health,Sockets,State,Outage Severity,Impact Duration,Remark\n";
      events.forEach((item, i) => {
        if (item.severity === "IGNORED") return;
        if (todayOnly && new Date(item.time).toLocaleDateString() !== todayStr) return;
        if (searchTerm) {
          const domStr = cleanDomainKey(item.domain || "").toLowerCase();
          const nodeStr = String(item.node || "").toLowerCase();
          if (!domStr.includes(searchTerm) && !nodeStr.includes(searchTerm)) return;
        }
        csv += buildCSVRow(item, i);
      });
      const prefix = searchTerm ? `WLMonitor_Filtered_${searchTerm}` : "WLMonitor_Global_ImpactReport";
      downloadCSV(csv, `${prefix}_${new Date().toISOString().split("T")[0]}.csv`);
    });
  }

  function downloadCSV(csv, fileName) {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  }

  fetchData();
  setInterval(fetchData, 1000);
});
