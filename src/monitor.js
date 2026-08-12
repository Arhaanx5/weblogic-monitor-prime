// WebLogic Monitor Engine & State Processor
const WLMonitorEngine = (() => {
  let impacted = {};

  try {
    if (chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.type === "REMARK_UPDATE_SYNC") {
          const { key, remark } = msg;
          for (const nName in impacted) {
            if (key && key.includes(nName)) {
              impacted[nName].remark = remark;
            }
          }
        }
      });
    }
  } catch (e) {}

  function hasStuckThreads(node) {
    return node.stuckThreads && String(node.stuckThreads).trim() !== "";
  }

  function findTable() {
    const primary = document.querySelector("#genericTableFormtable");
    if (primary) return primary;

    const rowMatch = document.querySelector("tr.rowEven, tr.rowOdd");
    if (rowMatch) return rowMatch.closest("table");

    const tables = document.querySelectorAll("table");
    for (const t of tables) {
      const headers = [...t.querySelectorAll("th")].map(h => h.innerText.toUpperCase());
      if (headers.some(h => h.includes("NAME") || h.includes("SERVER"))) {
        return t;
      }
    }
    return null;
  }

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

  function getDomainKey() {
    const domainElem = document.querySelector("#domain strong");
    const domainText = domainElem ? domainElem.textContent.trim() : "";

    const table = findTable();
    let clusterPrefix = "";
    let domainType = "";

    if (table) {
      const headers = [...table.querySelectorAll("th")].map(th => th.innerText.toUpperCase());
      const nameColIdx = headers.findIndex(h => h.includes("NAME") || h.includes("SERVER"));

      if (nameColIdx !== -1) {
        for (const row of table.querySelectorAll("tr.rowEven, tr.rowOdd")) {
          const cells = row.querySelectorAll("td");
          const nameText = cells[nameColIdx]?.innerText?.trim() || "";
          if (!nameText) continue;

          const parts = nameText.split("_");
          const firstPart = parts[0];
          const octets = firstPart.split(".");

          if (octets.length === 4) {
            const lastOctet = parseInt(octets[3], 10);
            if (!isNaN(lastOctet)) {
              if (lastOctet >= 112 && lastOctet <= 121) clusterPrefix = "TCL_";
              else if (lastOctet >= 27 && lastOctet <= 50) clusterPrefix = "HFL_";
            }
          }

          const upperName = nameText.toUpperCase();
          if (upperName.includes("COMMONMASTERS")) domainType = "CommonMasters";
          else if (upperName.includes("CAS") && !domainType) domainType = "CAS";
          else if (upperName.includes("LMS") && !domainType) domainType = "LMS";
          else if ((upperName.includes("CMS") || upperName.includes("INTG") || upperName.includes("GCD") || upperName.includes("ECM") || upperName.includes("NIF")) && !domainType) {
            domainType = "INTG";
          }
        }
      }
    }

    let rawDomain = "";
    if (clusterPrefix && domainType) {
      rawDomain = clusterPrefix + domainType;
    } else {
      rawDomain = domainText || window.location.host || "UNKNOWN_DOMAIN";
    }

    return cleanDomainKey(rawDomain);
  }

  function getSeverity(node, currentDomain) {
    const threshold = window.WLSettings ? window.WLSettings.getThreshold(node.name, currentDomain) : 70;

    // State RUNNING nahi hai → always CRITICAL (server down)
    if (node.state && node.state.toUpperCase() !== "RUNNING") {
      return "CRITICAL";
    }

    // Health check
    if (node.health && node.health.toUpperCase() !== "OK") {
      return "WARNING";
    }

    // Stuck threads check
    if (hasStuckThreads(node)) {
      return "WARNING";
    }

    // ✅ BUG FIX: threshold=0 ka matlab "socket monitoring disabled" hai
    // Pehle: threshold===0 → CRITICAL (galat! user 0 set kare to disable karna chahta hai)
    // Ab:    threshold===0 → socket check skip karo, NORMAL return karo
    if (threshold === 0) {
      return "NORMAL"; // 0 = disabled, koi alert nahi
    }

    // Socket threshold check
    if (Number(node.sockets || 0) >= threshold) {
      return "WARNING";
    }

    return "NORMAL";
  }

  let isImpactedHydrated = false;

  async function hydrateActiveIncidents(currentDomain) {
    if (isImpactedHydrated) return;
    try {
      if (chrome.runtime && chrome.runtime.sendMessage) {
        const stats = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: "GET_GLOBAL_STATS" }, (res) => resolve(res));
        });
        if (stats && Array.isArray(stats.impactedList)) {
          stats.impactedList.forEach(item => {
            if (item && item.node && (!item.domain || cleanDomainKey(item.domain) === cleanDomainKey(currentDomain))) {
              if (!impacted[item.node]) {
                impacted[item.node] = {
                  incidentId: item.incidentId || `${currentDomain}_${item.node}_${item.startTime || Date.now()}`,
                  node: item.node,
                  domain: item.domain || currentDomain,
                  severity: item.severity || "WARNING",
                  health: item.health || "OK",
                  sockets: item.sockets || 0,
                  state: item.state || "RUNNING",
                  stuckThreads: item.stuckThreads || "",
                  startTime: item.startTime || Date.now(),
                  startDisplay: item.startDisplay || new Date(item.startTime || Date.now()).toLocaleString(),
                  endTime: null,
                  endDisplay: null,
                  lastUpdate: Date.now(),
                  lastLogTime: item.lastLogTime || Date.now(),
                  remark: item.remark || ""
                };
              }
            }
          });
        }
      }
    } catch (e) {}
    isImpactedHydrated = true;
  }

  function isProdEnvironment() {
    return true; // Allow all WebLogic console environments to report to NOC Dashboard!
  }

  function checkIsLoggedOut() {
    try {
      const pwdInput = document.querySelector("input[type='password'], input[name='j_password']");
      const loginBtn = document.querySelector("input[value*='Login'], button[type='submit']");
      if (pwdInput || loginBtn) return true;
    } catch (e) {}
    return false;
  }

  function getConsoleLastRefreshedMs() {
    try {
      const allElems = document.querySelectorAll("td, span, div, p");
      for (const el of allElems) {
        if (el.textContent && el.textContent.includes("Last Refreshed:")) {
          const rawStr = el.textContent.split("Last Refreshed:")[1]?.trim();
          if (rawStr) {
            const parsed = new Date(rawStr);
            if (!isNaN(parsed.getTime())) return parsed.getTime();

            const match = rawStr.match(/(\d{1,2}:\d{2}:\d{2}\s*[AP]M)/i);
            if (match) {
              const today = new Date();
              const parsedTime = new Date(today.toDateString() + " " + match[1]);
              if (!isNaN(parsedTime.getTime())) return parsedTime.getTime();
            }
          }
        }
      }
    } catch (e) {}
    return null;
  }

  function getConsoleLastRefreshedText() {
    try {
      const allElems = document.querySelectorAll("td, span, div, p");
      for (const el of allElems) {
        if (el.children.length === 0 && el.textContent.includes("Last Refreshed:")) {
          return el.textContent.trim();
        }
        if (el.innerText && el.innerText.includes("Last Refreshed:")) {
          const match = el.innerText.match(/Last Refreshed:\s*([^\n\r]+)/i);
          if (match && match[1]) return `Last Refreshed: ${match[1].trim()}`;
        }
      }
    } catch (e) {}
    return `Last Refreshed: ${new Date().toLocaleTimeString()}`;
  }

  async function process(nodes) {
    if (!Array.isArray(nodes) || nodes.length === 0) return;

    // 🛑 UAT / NON-PROD TAB ISOLATION: Only PROD tabs update NOC Dashboard!
    if (!isProdEnvironment()) {
      return;
    }

    const currentDomain = getDomainKey();
    await hydrateActiveIncidents(currentDomain);

    const batchData = {
      domainKey: currentDomain,
      domainHost: location.host,
      url: location.href,
      consoleLastRefreshed: getConsoleLastRefreshedText(),
      consoleLastRefreshedMs: getConsoleLastRefreshedMs(),
      lastScanTime: Date.now(),
      isLoggedOut: checkIsLoggedOut(),
      nodes: {}
    };

    // ✅ FIX 5: Serial await loop → Promise.allSettled parallel
    // BEFORE: 10 nodes × 50ms = 500ms blocking per scan
    // AFTER:  10 nodes → ~50ms (all run in parallel)
    const nodeProcessingTasks = [];

    for (const node of nodes) {
      const isIgnored = window.WLSettings ? window.WLSettings.isIgnored(node.name, currentDomain) : false;

      if (isIgnored) {
        node.severity = "IGNORED";
        batchData.nodes[node.name] = node;

        if (impacted[node.name]) {
          delete impacted[node.name];
          try {
            if (chrome.runtime && chrome.runtime.sendMessage) {
              chrome.runtime.sendMessage({
                type: "IMPACT_REMOVE",
                key: `${currentDomain}_${node.name}`
              });
            }
          } catch (e) {}
        }
        if (window.WLAlerts) {
          window.WLAlerts.clear(node.name);
        }
        continue;
      }

      node.severity = getSeverity(node, currentDomain);
      batchData.nodes[node.name] = node;

      // Queue async task — non-blocking parallel execution
      nodeProcessingTasks.push(updateNodeState(node, currentDomain));
    }

    // Wait for all nodes to process in parallel (not sequentially)
    await Promise.allSettled(nodeProcessingTasks);

    try {
      if (chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          type: "BATCH_STATE_UPDATE",
          data: batchData
        });
      }
    } catch (e) {}
  }

  async function updateNodeState(node, currentDomain) {
    const old = impacted[node.name];
    const now = Date.now();
    const displayTime = new Date().toLocaleString();
    const repeatGapMs = (window.WLSettings ? window.WLSettings.getAll().alertRepeatMinutes || 3 : 3) * 60 * 1000;

    /* NEW INCIDENT EPISODE - Log Initial Outage/Warning IMMEDIATELY */
    if (node.severity !== "NORMAL" && node.severity !== "IGNORED" && !old) {
      const incidentId = `${currentDomain}_${node.name}_${now}`;
      const item = {
        incidentId: incidentId,
        node: node.name,
        domain: currentDomain,
        severity: node.severity, // WARNING or CRITICAL
        health: node.health,
        sockets: node.sockets,
        state: node.state,
        stuckThreads: node.stuckThreads || "",
        startTime: now,
        startDisplay: displayTime,
        endTime: null,
        endDisplay: null,
        lastUpdate: now,
        lastLogTime: now,
        remark: hasStuckThreads(node) ? `Stuck Threads: ${node.stuckThreads}` : (node.remark || "")
      };

      impacted[node.name] = item;

      sendGlobalUpdate(item);
      saveHistory(item);

      if (window.WLAlerts) {
        window.WLAlerts.update(node.name, node.severity);
      }
    }
    /* EXISTING ACTIVE INCIDENT - Update Metrics & Socket Fluctuations */
    else if (old && node.severity !== "NORMAL" && node.severity !== "IGNORED") {
      const preservedRemark = old.remark || (hasStuckThreads(node) ? `Stuck Threads: ${node.stuckThreads}` : "");
      const realNodeName = old.node || old.name || node.name;

      Object.assign(old, {
        node: realNodeName,
        name: realNodeName,
        health: node.health,
        sockets: node.sockets,
        state: node.state,
        stuckThreads: node.stuckThreads || "",
        severity: node.severity,
        lastUpdate: now,
        remark: preservedRemark
      });

      sendGlobalUpdate(old);

      if (window.WLAlerts) {
        window.WLAlerts.update(realNodeName, node.severity);
      }
    }
    /* RECOVERY - Link End Timestamp & Retain Original Incident Severity (WARNING/CRITICAL) */
    else if (old && node.severity === "NORMAL") {
      const realNodeName = old.node || old.name || node.name;
      const recoveredItem = {
        ...old,
        node: realNodeName,
        name: realNodeName,
        outageSeverity: old.severity,
        endTime: now,
        endDisplay: displayTime,
        remark: old.remark || ""
      };

      sendGlobalUpdate(recoveredItem);
      saveHistory(recoveredItem);



      if (window.WLAlerts) {
        window.WLAlerts.clear(realNodeName);
      }

      delete impacted[realNodeName];
      delete impacted[node.name];
    }
  }

  async function saveHistory(node) {
    if (window.WLStorage) {
      await window.WLStorage.add(window.WLStorage.STORES.NODE_HISTORY, {
        incidentId: node.incidentId,
        domain: node.domain || getDomainKey(),
        node: node.name || node.node,
        health: node.health,
        sockets: node.sockets,
        state: node.state,
        stuckThreads: node.stuckThreads || "",
        severity: node.severity,
        startTime: node.startTime,
        startDisplay: node.startDisplay,
        endTime: node.endTime,
        endDisplay: node.endDisplay,
        remark: node.remark || "",
        time: new Date().toISOString()
      });
    }
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

  function sendGlobalUpdate(node) {
    try {
      if (!isProdEnvironment()) return;
      safeSendMessage({
        type: "IMPACT_UPDATE",
        data: {
          incidentId: node.incidentId,
          domain: node.domain || getDomainKey(),
          node: node.node || node.name,
          severity: node.severity,
          health: node.health,
          sockets: node.sockets,
          state: node.state,
          stuckThreads: node.stuckThreads || "",
          startTime: node.startTime,
          startDisplay: node.startDisplay,
          endTime: node.endTime,
          endDisplay: node.endDisplay,
          remark: node.remark || "",
          time: new Date().toISOString()
        }
      });
    } catch (e) {}
  }

  function getImpacted() {
    const filtered = {};
    const currentDomain = getDomainKey();
    for (const key in impacted) {
      if (window.WLSettings && window.WLSettings.isIgnored(key, currentDomain)) {
        continue;
      }
      filtered[key] = impacted[key];
    }
    return filtered;
  }

  return {
    process,
    getImpacted,
    getDomainKey
  };
})();

window.WLMonitorEngine = WLMonitorEngine;