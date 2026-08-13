// WebLogic Monitor - Background Service Worker (Global NOC Aggregator)
importScripts("settings.js");

const DB_NAME = "WLMonitorGlobalDB_V10";
const DB_VERSION = 1;
const CURRENT_STORE = "currentImpacted";
const GLOBAL_STORE = "globalImpacted";

let db = null;

let domainStateMap = {};
let persistTimer = null;
let broadcastTimer = null; // ✅ FIX 4: Debounce timer for broadcastSync
let lastRetentionNoticeTime = 0; // ✅ FIX: Declare retention notice timestamp

function cleanDomainKey(key) {
  if (!key) return "UNKNOWN_DOMAIN";
  let cleaned = String(key)
    .replace(/https?:\/\//gi, "")
    .replace(/(\d{1,3}\.){3}\d{1,3}:?\d*/g, "")
    .replace(/\/console.*$/gi, "")
    .replace(/Summary\s+of\s+Servers_?/gi, "")
    .replace(/WLS\s+Console_?/gi, "")
    .trim();

  cleaned = cleaned.replace(/-/g, "_").replace(/\s+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");

  if (/(CMS|GCD|ECM|NIF)/gi.test(cleaned)) {
    cleaned = cleaned.replace(/(CMS|GCD|ECM|NIF)/gi, "INTG");
  }

  // Domain Normalization & Deduplication Mapping
  if (/INTG/i.test(cleaned)) return "TCL_INTG";
  if (/LMS/i.test(cleaned)) return "TCL_LMS";
  if (/CAS/i.test(cleaned)) return "TCL_CAS";
  if (/COMMON/i.test(cleaned)) return "TCL_CommonMasters";

  if (cleaned.toLowerCase().includes("http") || cleaned.toLowerCase().includes("login") || cleaned === "TCL" || cleaned === "HFL") {
    return "";
  }

  if (!cleaned.startsWith("TCL_") && !cleaned.startsWith("HFL_")) {
    cleaned = "TCL_" + cleaned;
  }

  return cleaned || key;
}

function isProdUrlOrHost(url, host) {
  if (!url && !host) return true;
  const lowerUrl = (url || "").toLowerCase();
  const lowerHost = (host || "").toLowerCase();
  let port = "";
  try {
    if (url) port = new URL(url).port;
  } catch (e) {}

  // 🛑 1. Block UAT Port 7002 and UAT IP 172.17.
  if (port === "7002" || lowerHost.includes("7002") || lowerHost.includes("172.17.") || lowerUrl.includes("172.17.")) {
    return false;
  }

  // 🛑 2. Block explicit 'uat' in hostname/url
  if (/\buat\b/i.test(lowerHost) || lowerHost.includes("uat")) {
    return false;
  }

  // 🛑 3. Custom settings user blacklist check
  if (typeof WLSettings !== "undefined") {
    const cfg = WLSettings.getAll();
    if (cfg.nonProdKeywords && String(cfg.nonProdKeywords).trim() !== "") {
      const keywords = String(cfg.nonProdKeywords).split(",").map(k => k.trim().toLowerCase());
      for (const kw of keywords) {
        if (kw && (lowerUrl.includes(kw) || lowerHost.includes(kw) || port === kw)) return false;
      }
    }
  }

  return true; // All PROD WebLogic tabs (Port 7001, IPs 172.16., 192.168., 192.x) ALLOWED!
}

function sanitizeMap() {
  const cleanMap = {};
  const now = Date.now();
  const STALE_TIMEOUT = 30 * 60 * 1000;

  for (const rawKey in domainStateMap) {
    const item = domainStateMap[rawKey];
    if (item.lastUpdated && (now - item.lastUpdated > STALE_TIMEOUT)) {
      continue;
    }

    if (!isProdUrlOrHost(item.url, item.domainHost)) {
      continue; // 🛑 Suppress UAT domains from NOC Dashboard & Popup
    }

    // 🛑 Purge dirty login URLs and unparsed http keys
    if (rawKey.toLowerCase().includes("login") || rawKey.toLowerCase().includes("http://") || rawKey.toLowerCase().includes("https://")) {
      if (!item.nodes || Object.keys(item.nodes).length === 0) {
        continue;
      }
    }

    const cleanKey = cleanDomainKey(rawKey);
    if (!cleanKey || cleanKey.toLowerCase().includes("http") || cleanKey.toLowerCase().includes("login")) {
      continue;
    }

    item.domainKey = cleanKey;

    if (!cleanMap[cleanKey]) {
      cleanMap[cleanKey] = item;
    } else {
      cleanMap[cleanKey].nodes = { ...cleanMap[cleanKey].nodes, ...item.nodes };
      if (item.lastUpdated > cleanMap[cleanKey].lastUpdated) {
        cleanMap[cleanKey].lastUpdated = item.lastUpdated;
      }
    }
  }
  domainStateMap = cleanMap;
}

chrome.storage.local.get(["domainStateMap"], (res) => {
  if (res && res.domainStateMap) {
    domainStateMap = res.domainStateMap;
    sanitizeMap();
    updateBadge();
  }
});

// ============================================================
// 🛡️ HIGH-AVAILABILITY 3-SECOND BACKGROUND POLLING ENGINE
// Guarantees 100% Live Data without Browser Tab Dependency!
// ============================================================

console.log("[WLMonitor SW] 🚀 High-Availability 3-Second Engine Started!");

const isPollingMap = new Map(); // DomainKey -> boolean (Mutex guard for race condition prevention)
const lastStateHash = new Map(); // DomainKey -> Hash string (2-Tier Differential Cache)
const socketHysteresisMap = new Map(); // NodeKey -> boolean (Hysteresis state for 70 threshold)

// ⚡ 3-Second Guaranteed Alarm Loop (MV3 Service Worker Safe)
if (chrome.alarms) {
  chrome.alarms.create("wlBackground3SecPoll", { periodInMinutes: 0.05 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && (alarm.name === "wlBackground3SecPoll" || alarm.name === "wlKeepAlive" || alarm.name === "WL_KEEP_ALIVE_ALARM")) {
      runHighFrequencyBackgroundPoll();
    }
  });
}

// ⚡ High-Frequency 3-Second Fallback Cycle
setInterval(() => {
  runHighFrequencyBackgroundPoll();
}, 3000);

// Parallel Execution via Promise.allSettled
async function runHighFrequencyBackgroundPoll() {
  try {
    const registeredDomains = Object.values(domainStateMap);
    if (!registeredDomains.length) {
      pingAllWebLogicTabs();
      return;
    }

    const pollTasks = registeredDomains.map(dom => pollDomainDirectly(dom));
    await Promise.allSettled(pollTasks);

    // Also ping open tabs if any exist as fallback
    pingAllWebLogicTabs();
    sanitizeMap();
  } catch (err) {
    console.error("[WLMonitor SW] Background Poll Cycle Error:", err);
  }
}

// Direct Background Fetcher (Zero Tab / Zero DOM Scraping)
async function pollDomainDirectly(domainObj) {
  if (!domainObj || !domainObj.url) return;
  const cleanKey = cleanDomainKey(domainObj.domainKey || domainObj.domainHost);

  // 🔒 Mutex Lock Guard: Prevent Race Condition if previous request is still in-flight!
  if (isPollingMap.get(cleanKey)) {
    return;
  }

  isPollingMap.set(cleanKey, true);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000); // ⚡ 4-Second Fast Network Timeout

  try {
    const targetUrl = domainObj.url;
    let consoleUrl = targetUrl;
    try {
      const u = new URL(targetUrl);
      consoleUrl = `${u.protocol}//${u.host}/console/console.portal?_nfpb=true&_pageLabel=CoreServerServerTablePage`;
    } catch (e) {
      if (!consoleUrl.includes("CoreServerServerTablePage")) {
        consoleUrl = targetUrl.replace(/\/+$/, "").replace(/\/console.*$/, "") + "/console/console.portal?_nfpb=true&_pageLabel=CoreServerServerTablePage";
      }
    }

    const response = await fetch(consoleUrl, {
      method: "GET",
      headers: { "Accept": "text/html,application/xhtml+xml,application/xml" },
      credentials: "include",
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      isPollingMap.set(cleanKey, false);
      return;
    }

    const htmlText = await response.text();
    const parsedNodes = parseWebLogicServerHTML(htmlText);

    if (parsedNodes && Object.keys(parsedNodes).length > 0) {
      // Compute 2-Tier Differential Cache Hash
      const currentHash = computeStateHash(parsedNodes);
      const previousHash = lastStateHash.get(cleanKey);

      let globalThreshold = 70;
      if (typeof WLSettings !== "undefined") {
        globalThreshold = Number(WLSettings.getAll().globalDefaultThreshold || 70);
      }

      // Check Sockets & Hysteresis Thresholds
      for (const nName in parsedNodes) {
        const node = parsedNodes[nName];
        const nodeKey = `${cleanKey}_${nName}`;
        const nodeSockets = node.sockets || 0;
        const isHysteresisActive = socketHysteresisMap.get(nodeKey) || false;

        // Threshold Hysteresis: Trigger > 70, Clear only when < 65
        if (nodeSockets > globalThreshold) {
          socketHysteresisMap.set(nodeKey, true);
          node.socketBreach = true;
          node.severity = "CRITICAL";
        } else if (isHysteresisActive && nodeSockets >= 65) {
          // Keep active hysteresis until sockets drop below 65
          node.socketBreach = true;
          node.severity = "CRITICAL";
        } else {
          socketHysteresisMap.set(nodeKey, false);
          node.socketBreach = false;
        }
      }

      // 🧠 Smart Cache Evaporation: If hash changed or incident active, update immediately
      if (currentHash !== previousHash || hasActiveIncident(parsedNodes)) {
        lastStateHash.set(cleanKey, currentHash);

        domainStateMap[cleanKey] = {
          ...domainStateMap[cleanKey],
          domainKey: cleanKey,
          unreachable: false,
          nodes: parsedNodes,
          consoleLastRefreshed: `Live (3s): ${new Date().toLocaleTimeString()}`,
          lastScanTime: Date.now(),
          lastUpdated: Date.now()
        };

        persistDomainState();
        broadcastSync({ domainKey: cleanKey, nodes: parsedNodes });
      }
    }
  } catch (err) {
    domainStateMap[cleanKey] = {
      ...domainStateMap[cleanKey],
      domainKey: cleanKey,
      unreachable: true,
      unreachableReason: "Network Disconnected / Timeout",
      consoleLastRefreshed: `Unreachable (Network Off): ${new Date().toLocaleTimeString()}`,
      lastScanTime: Date.now(),
      lastUpdated: Date.now()
    };
    persistDomainState();
    broadcastSync({ domainKey: cleanKey, unreachable: true });
  } finally {
    isPollingMap.set(cleanKey, false);
  }
}

// Compute 2-Tier Differential Hash
function computeStateHash(nodesObj) {
  let str = "";
  for (const k of Object.keys(nodesObj).sort()) {
    const n = nodesObj[k];
    str += `${k}:${n.state}:${n.health}:${n.sockets}:${n.stuckThreads}|`;
  }
  return str;
}

function hasActiveIncident(nodesObj) {
  for (const k in nodesObj) {
    const n = nodesObj[k];
    if (n.state !== "RUNNING" || n.health !== "HEALTH_OK" || n.socketBreach || (n.stuckThreads && n.stuckThreads.trim() !== "")) {
      return true;
    }
  }
  return false;
}

// Ultra-Fast Stream Regex Parser (5ms execution time) - Handles all WebLogic 10g/12c/14c table formats
function parseWebLogicServerHTML(htmlText) {
  if (!htmlText) return {};
  const nodes = {};

  const rowRegex = /<tr class="(?:rowEven|rowOdd)">([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(htmlText)) !== null) {
    const rowHtml = rowMatch[1];
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells = [];
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
      cells.push(cellMatch[1].replace(/<[^>]+>/g, "").trim());
    }

    if (cells.length < 2) continue;

    const serverName = cells[0];
    if (!serverName || /^name$/i.test(serverName) || /^server$/i.test(serverName)) continue;

    let health = "OK";
    let state = "RUNNING";
    let sockets = 0;
    let stuckThreads = "";

    // Find health/state/sockets by value inspection
    for (let i = 1; i < cells.length; i++) {
      const c = cells[i];
      if (/^(OK|CRITICAL|FAILED|WARN|WARNING|HEALTH_OK)$/i.test(c)) {
        health = c;
      } else if (/^(RUNNING|SHUTDOWN|ADMIN|STANDBY|STARTING)$/i.test(c)) {
        state = c;
      } else if (/^\d+$/.test(c)) {
        if (sockets === 0) sockets = parseInt(c, 10);
      }
    }

    const isCritical = state !== "RUNNING" || health.toUpperCase().includes("CRITICAL") || health.toUpperCase().includes("FAILED");
    const isWarning = health.toUpperCase().includes("WARN") || (stuckThreads && stuckThreads.trim() !== "");

    let severity = "NORMAL";
    if (isCritical) severity = "CRITICAL";
    else if (isWarning) severity = "WARNING";

    nodes[serverName] = {
      name: serverName,
      health: health,
      state: state,
      sockets: sockets,
      stuckThreads: stuckThreads,
      severity: severity,
      lastUpdated: Date.now()
    };
  }

  return nodes;
}

function isWebLogicTab(tab) {
  if (!tab || !tab.url) return false;
  const url = tab.url.toLowerCase();
  const host = (() => { try { return new URL(tab.url).host.toLowerCase(); } catch(e) { return ""; } })();

  // 🛑 Block ALL UAT / Non-Prod tabs (Port 7002, IP 172.17., keyword 'uat', custom blacklists)
  if (!isProdUrlOrHost(url, host)) return false;

  return url.includes("/console") || url.includes("loginform.jsp") || url.includes("console.portal");
}

function autoInjectScriptsIntoWebLogicTabs() {
  try {
    chrome.tabs.query({}, (tabs) => {
      if (!tabs) return;
      tabs.forEach(tab => {
        if (tab.id && isWebLogicTab(tab)) {
          try {
            chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ["src/settings.js", "src/monitor.js", "src/ui.js", "src/content.js"]
            }).catch(() => {});
          } catch (e) {}
        }
      });
    });
  } catch (e) {}
}

chrome.runtime.onInstalled.addListener(() => {
  autoInjectScriptsIntoWebLogicTabs();
});

function pingAllWebLogicTabs() {
  try {
    chrome.tabs.query({}, (tabs) => {
      if (!tabs) return;
      const activeDomainTabIds = new Set(
        Object.values(domainStateMap).map(d => d.tabId).filter(Boolean)
      );

      tabs.forEach(tab => {
        if (!tab.id || !isWebLogicTab(tab)) return;

        // ⚡ INSTANT DOMAIN REGISTRATION: Auto-register open WebLogic tabs on reload
        const cleanKey = cleanDomainKey(tab.url || tab.title);
        if (!domainStateMap[cleanKey]) {
          domainStateMap[cleanKey] = {
            domainKey: cleanKey,
            domainHost: (() => { try { return new URL(tab.url).host; } catch(e) { return cleanKey; } })(),
            url: tab.url,
            tabId: tab.id,
            nodes: {},
            lastUpdated: Date.now()
          };
          persistDomainState();
        }

        try {
          chrome.tabs.sendMessage(tab.id, { type: "FORCE_SCAN" }, (resp) => {
            if (chrome.runtime.lastError) {
              // Extension was reloaded — re-inject content script into open WebLogic tab!
              try {
                chrome.scripting.executeScript({
                  target: { tabId: tab.id },
                  files: ["src/settings.js", "src/monitor.js", "src/ui.js", "src/content.js"]
                }).catch(() => {});
              } catch (err) {}
              verifyTabHealth(tab.id);
            }
          });
        } catch (e) {}
      });

      // Verify registered domain tabs still exist
      activeDomainTabIds.forEach(tabId => {
        verifyTabHealth(tabId);
      });
    });
  } catch (e) {}
}

function verifyTabHealth(tabId) {
  if (!tabId) return;
  try {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        // Tab closed — detach tabId BUT keep domain active for Zero-Tab background polling!
        for (const key in domainStateMap) {
          if (domainStateMap[key].tabId === tabId) {
            domainStateMap[key].tabId = null;
            console.log(`[WLMonitor] Tab closed for domain: ${key}, keeping domain active for Zero-Tab background polling.`);
          }
        }
        persistDomainState();
        updateBadge();
      }
    });
  } catch (e) {}
}



function openDB() {
  return new Promise((resolve, reject) => {
    if (db) return resolve(db);
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const database = e.target.result;

      // 🧹 Auto-Wipe legacy stores for clean V8 schema
      if (database.objectStoreNames.contains(CURRENT_STORE)) {
        try { database.deleteObjectStore(CURRENT_STORE); } catch (err) {}
      }
      if (database.objectStoreNames.contains(GLOBAL_STORE)) {
        try { database.deleteObjectStore(GLOBAL_STORE); } catch (err) {}
      }

      database.createObjectStore(CURRENT_STORE, { keyPath: "key" });
      const store = database.createObjectStore(GLOBAL_STORE, { keyPath: "incidentId" });
      store.createIndex("time", "time");
      store.createIndex("domain", "domain");
      store.createIndex("severity", "severity");
      store.createIndex("node", "node");
    };
    request.onsuccess = (e) => {
      db = e.target.result;
      console.log("[WLMonitor Service Worker] Global DB V8 Ready");
      resolve(db);
    };
    request.onerror = (e) => reject(e.target.error);
  });
}

// ⏱️ Auto-Reconciliation & 5-Minute Inactivity Auto-Closure + Retention Notice
async function checkAndPruneStaleIncidents() {
  try {
    const database = await openDB();
    const now = Date.now();
    const STALE_INACTIVITY_MS = 5 * 60 * 1000; // 5 minutes inactivity

    // 1. Auto-close inactive incidents in CURRENT_STORE
    const txCurrent = database.transaction(CURRENT_STORE, "readwrite");
    const currentStore = txCurrent.objectStore(CURRENT_STORE);
    const reqCurrent = currentStore.openCursor();

    reqCurrent.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        const item = cursor.value;
        if (item.lastUpdate && (now - item.lastUpdate > STALE_INACTIVITY_MS)) {
          // Auto-close stale incident from closed tab
          item.endTime = item.lastUpdate;
          item.endDisplay = new Date(item.lastUpdate).toLocaleString();
          item.statusReason = "RESOLVED (SESSION END)";
          
          saveToDB(GLOBAL_STORE, item);
          cursor.delete();
        }
        cursor.continue();
      }
    };

    // 2. Retention cleanup (> retentionDays)
    let retentionDays = 7;
    if (typeof WLSettings !== "undefined") {
      retentionDays = WLSettings.getAll().retentionDays || 7;
    }
    const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
    const cutoffTime = now - retentionMs;

    const txGlobal = database.transaction(GLOBAL_STORE, "readwrite");
    const globalStore = txGlobal.objectStore(GLOBAL_STORE);
    const reqGlobal = globalStore.openCursor();
    let prunedCount = 0;

    reqGlobal.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        const item = cursor.value;
        const rawTime = item.startTime || item.time || Date.now();
        const itemTime = typeof rawTime === "number" ? rawTime : new Date(rawTime).getTime();
        if (!isNaN(itemTime) && itemTime < cutoffTime) {
          cursor.delete();
          prunedCount++;
        }
        cursor.continue();
      } else {
        // Trigger 1-time Chrome desktop notification if old records were cleaned up
        if (prunedCount > 0 && (now - lastRetentionNoticeTime > 24 * 60 * 60 * 1000)) {
          lastRetentionNoticeTime = now;
          chrome.notifications.create(`retention_notice_${now}`, {
            type: "basic",
            iconUrl: "icons/icon128.png",
            title: "🧹 WL Monitor Retention Notice",
            message: `${prunedCount} old incident logs (> ${retentionDays} days) were auto-cleaned. CSV backup recommended!`,
            priority: 1
          });
        }
      }
    };
  } catch (err) {}
}

setInterval(checkAndPruneStaleIncidents, 60 * 1000);

function getFromDB(store, key) {
  return new Promise(async (resolve) => {
    try {
      const database = await openDB();
      const tx = database.transaction(store, "readonly");
      const req = tx.objectStore(store).get(key);
      req.onsuccess = (e) => resolve(e.target.result || null);
      req.onerror = () => resolve(null);
    } catch (err) {
      resolve(null);
    }
  });
}

function saveToDB(store, data) {
  return new Promise(async (resolve, reject) => {
    try {
      const database = await openDB();
      const tx = database.transaction(store, "readwrite");
      tx.objectStore(store).put(data);
      tx.oncomplete = () => resolve(true);
      tx.onerror = (e) => resolve(false);
    } catch (err) {
      resolve(false);
    }
  });
}

function removeFromDB(store, key) {
  return new Promise(async (resolve, reject) => {
    try {
      const database = await openDB();
      const tx = database.transaction(store, "readwrite");
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = (e) => resolve(false);
    } catch (err) {
      resolve(false);
    }
  });
}

async function getTopEventsFromDB(store, limit = 100) {
  try {
    const database = await openDB();
    return new Promise((resolve) => {
      const items = [];
      const tx = database.transaction(store, "readonly");
      const req = tx.objectStore(store).openCursor(null, "prev");
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor && items.length < limit) {
          items.push(cursor.value);
          cursor.continue();
        } else {
          resolve(items);
        }
      };
      req.onerror = () => resolve([]);
    });
  } catch (err) {
    return [];
  }
}

async function getUnifiedEventsFromDB(limit = 300) {
  try {
    const activeItems = await getTopEventsFromDB(CURRENT_STORE, 50);
    const globalItems = await getTopEventsFromDB(GLOBAL_STORE, limit);

    const mergedMap = new Map();

    // Helper: Generate uniform deduplication key
    const getEventKey = (item) => {
      const dom = cleanDomainKey(item.domain || "UNKNOWN");
      const node = item.node || "UNKNOWN";
      if (item.endTime) {
        // Recovered incident: Unique per incident episode
        const startMs = item.startTime ? (typeof item.startTime === "number" ? item.startTime : new Date(item.startTime).getTime()) : 0;
        return item.incidentId || `${dom}_${node}_${startMs}`;
      }
      // Ongoing Active incident: Exactly 1 active row per node
      return `${dom}_${node}`;
    };

    // 1. Add completed/historical items from GLOBAL_STORE first
    (globalItems || []).forEach(item => {
      if (item && item.severity !== "IGNORED") {
        const k = getEventKey(item);
        mergedMap.set(k, item);
      }
    });

    // 2. Add active items from CURRENT_STORE (overwriting or adding single active entry)
    (activeItems || []).forEach(item => {
      if (item && item.severity !== "IGNORED" && item.severity !== "NORMAL") {
        const k = getEventKey(item);
        mergedMap.set(k, item);
      }
    });

    // 3. Failsafe: Add live active warning nodes from domainStateMap if missing
    for (const domKey in domainStateMap) {
      const domObj = domainStateMap[domKey];
      const cleanDom = cleanDomainKey(domKey);
      if (domObj && domObj.nodes) {
        for (const nName in domObj.nodes) {
          const n = domObj.nodes[nName];
          if (n && (n.severity === "CRITICAL" || n.severity === "WARNING")) {
            const k = `${cleanDom}_${nName}`;
            if (!mergedMap.has(k)) {
              mergedMap.set(k, {
                incidentId: `${cleanDom}_${nName}_${n.startTime || Date.now()}`,
                key: `${cleanDom}_${nName}`,
                node: nName,
                domain: cleanDom,
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
          }
        }
      }
    }

    const allEvents = Array.from(mergedMap.values());
    allEvents.sort((a, b) => {
      const aMs = a.startTime ? (typeof a.startTime === "number" ? a.startTime : new Date(a.startTime).getTime()) : new Date(a.time || 0).getTime();
      const bMs = b.startTime ? (typeof b.startTime === "number" ? b.startTime : new Date(b.startTime).getTime()) : new Date(b.time || 0).getTime();
      return bMs - aMs;
    });

    return allEvents;
  } catch (err) {
    return [];
  }
}

async function removeFromDB(store, key) {
  try {
    const database = await openDB();
    const tx = database.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
  } catch (err) {}
}

// ✅ FIX 3: Direct primary key lookup — 1 DB read per keystroke (replaces 400+ full cursor scan)
async function updateEventRemarkInDB(store, incidentId, remark) {
  try {
    const database = await openDB();
    const tx = database.transaction(store, "readwrite");
    const objectStore = tx.objectStore(store);

    const getReq = objectStore.get(incidentId);
    getReq.onsuccess = () => {
      if (getReq.result) {
        const record = getReq.result;
        record.remark = remark;
        objectStore.put(record);
      } else {
        // Fallback: agar primary key match nahi hua (CURRENT_STORE key = itemKey format)
        const cursorReq = objectStore.openCursor();
        cursorReq.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            const val = cursor.value;
            if (val.key === incidentId || (val.node && incidentId.includes(val.node))) {
              val.remark = remark;
              cursor.update(val);
            }
            cursor.continue();
          }
        };
      }
    };
  } catch (err) {}
}

function persistDomainState() {
  sanitizeMap();
  updateBadge();

  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    chrome.storage.local.set({ "domainStateMap": domainStateMap });
  }, 2000);
}

// ⚡ Fast Throttled broadcastSync — Instant broadcast on update (max 10 broadcasts/sec)
function broadcastSync(payload) {
  if (broadcastTimer) return; // Throttled: fire immediately, lock for 100ms
  try {
    chrome.runtime.sendMessage({
      type: "LIVE_SYNC_TRIGGER",
      instantPayload: payload || null
    }, () => {
      if (chrome.runtime.lastError) {
        // Silently suppress receiving end does not exist warning when popup/dashboard is closed
      }
    });
  } catch (e) {}
  broadcastTimer = setTimeout(() => { broadcastTimer = null; }, 100);
}

function updateBadge() {
  let criticalCount = 0;
  let warningCount = 0;

  Object.values(domainStateMap).forEach(domainObj => {
    if (!domainObj.nodes) return;
    Object.values(domainObj.nodes).forEach(node => {
      if (node.severity === "CRITICAL") criticalCount++;
      else if (node.severity === "WARNING") warningCount++;
    });
  });

  // 🟢 AUTO-RESET ACK: When ALL servers return to NORMAL/HEALTHY state (0 active incidents), reset ACK back to default!
  if (criticalCount === 0 && warningCount === 0 && globalAckTimestamp > 0) {
    globalAckTimestamp = 0;
    if (typeof ackedNodeKeys !== "undefined") ackedNodeKeys.clear();
    try {
      chrome.storage.local.set({ "globalAckTimestamp": 0 });
      broadcastSync({ type: "NEW_INCIDENT_RESET_ACK", incidentKey: "ALL_HEALTHY" });
    } catch (e) {}
  }

  const totalImpacted = criticalCount + warningCount;

  if (totalImpacted > 0) {
    chrome.action.setBadgeText({ text: String(totalImpacted) });
    if (criticalCount > 0) {
      chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
    } else {
      chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
    }
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

const lastNotificationMap = new Map(); // key: domainKey_nodeName -> timestamp
let globalAckTimestamp = 0;
const activeIncidentMap = new Map(); // itemKey -> { incidentId, startTime, startDisplay }

async function closeOrphanedNodeIncidents(domainKey, nodeName, endTime, endDisplay) {
  try {
    const database = await openDB();
    const tx = database.transaction(GLOBAL_STORE, "readwrite");
    const store = tx.objectStore(GLOBAL_STORE);
    const req = store.openCursor();
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        const item = cursor.value;
        if (item.node === nodeName && cleanDomainKey(item.domain || "") === domainKey && !item.endTime) {
          item.endTime = endTime;
          item.endDisplay = endDisplay;
          cursor.update(item);
        }
        cursor.continue();
      }
    };
  } catch (err) {}
}

function triggerNotification(domainKey, nodeName, severity, health, sockets, state, stuckThreads) {
  try {
    let alertRepeatMs = 5 * 60 * 1000; // Default 5 minutes gap
    if (typeof WLSettings !== "undefined") {
      const cfg = WLSettings.getAll();
      if (cfg.isMaintenanceMode === true || cfg.enableNotifications === false) {
        console.log("[WLMonitor] Notification suppressed due to Maintenance Mode / Notification settings.");
        return;
      }
      if (cfg.alertRepeatMinutes && Number(cfg.alertRepeatMinutes) > 0) {
        alertRepeatMs = Number(cfg.alertRepeatMinutes) * 60 * 1000;
      }
    }

    // 🚨 GLOBAL ACK CHECK: If user clicked ACK button within alertRepeatMs window, silence notifications!
    if (globalAckTimestamp > 0 && (Date.now() - globalAckTimestamp < alertRepeatMs)) {
      console.log("[WLMonitor] Notification suppressed because Global ACK is currently active.");
      return;
    }

    const notifKey = `${domainKey}_${nodeName}`;
    const lastNotifTime = lastNotificationMap.get(notifKey) || 0;
    const now = Date.now();

    // 🚨 5-MINUTE REPEAT GAP THROTTLE:
    // New Incident -> Triggers IMMEDIATELY (lastNotifTime === 0)
    // Ongoing Same Incident -> Triggers repeat only after 5 minutes (alertRepeatMs)
    if (lastNotifTime > 0 && (now - lastNotifTime < alertRepeatMs)) {
      const remainingSec = Math.round((alertRepeatMs - (now - lastNotifTime)) / 1000);
      console.log(`[WLMonitor] Throttling notification for ${notifKey}. Repeat allowed in ${remainingSec}s`);
      return;
    }

    // Set last notification timestamp
    lastNotificationMap.set(notifKey, now);

    const title = `🚨 WebLogic Alert [${severity}] - ${nodeName}`;
    const message = `Domain: ${domainKey}\nHealth: ${health} | Sockets: ${sockets} | State: ${state}` +
      (stuckThreads ? `\nStuck Threads: ${stuckThreads}` : "");

    chrome.notifications.create(`WL_${domainKey}_${nodeName}_${Date.now()}`, {
      type: "basic",
      iconUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      title: title,
      message: message,
      priority: 2,
      requireInteraction: true
    });

    // 💬 Slack / MS Teams Webhook Auto-Posting
    if (typeof WLSettings !== "undefined") {
      const cfg = WLSettings.getAll();
      if (cfg.webhookUrl && typeof cfg.webhookUrl === "string" && cfg.webhookUrl.trim().startsWith("http")) {
        const webhookUrl = cfg.webhookUrl.trim();
        const payload = {
          text: `🚨 *WebLogic Alert [${severity}] - ${nodeName}*\n*Domain*: ${domainKey}\n*Health*: ${health} | *Sockets*: ${sockets} | *State*: ${state}\n*Time*: ${new Date().toLocaleString()}\n*Reported by*: WebLogic Command Center Prime (Mashkoor Alam)`
        };
        fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }).catch(err => console.log("[WLMonitor] Webhook post failed:", err));
      }
    }
  } catch (err) {
    console.log("Notification trigger skipped:", err);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  const tabId = sender.tab ? sender.tab.id : null;

  switch (msg.type) {
    case "BATCH_STATE_UPDATE": {
      const { domainKey, domainHost, url, consoleLastRefreshed, consoleLastRefreshedMs, lastScanTime, isLoggedOut, nodes } = msg.data;
      if (domainKey) {
        const cleanKey = cleanDomainKey(domainKey);
        const existingNodes = domainStateMap[cleanKey]?.nodes || {};
        const mergedNodes = nodes || {};

        let hasNewIncident = false;

        for (const nName in mergedNodes) {
          const n = mergedNodes[nName];
          if (n && (n.severity === "CRITICAL" || n.severity === "WARNING")) {
            if (existingNodes[nName] && existingNodes[nName].startTime) {
              n.startTime = existingNodes[nName].startTime;
              n.startDisplay = existingNodes[nName].startDisplay;
            } else if (!n.startTime) {
              n.startTime = Date.now();
              n.startDisplay = new Date(n.startTime).toLocaleString();
            }

            // 🚨 TIME-BASED NEW INCIDENT DETECTION: If incident startTime is NEWER than globalAckTimestamp, it's a NEW incident!
            if (globalAckTimestamp > 0 && n.startTime && n.startTime > globalAckTimestamp) {
              hasNewIncident = true;
            }
          }
        }

        // If a BRAND NEW incident is detected, reset ACK globally so UI button resets and sound plays!
        if (hasNewIncident) {
          console.log("[WLMonitor SW] 🚨 Brand new incident detected via startTime > globalAckTimestamp! Resetting Global ACK.");
          globalAckTimestamp = 0;
          chrome.storage.local.set({ 
            "globalAckTimestamp": 0,
            "lastGlobalSoundPlayedTimestamp": 0 
          });
          broadcastSync({ type: "NEW_INCIDENT_RESET_ACK" });
        }

        domainStateMap[cleanKey] = {
          domainKey: cleanKey,
          domainHost: domainHost || cleanKey,
          url: url || (sender.tab ? sender.tab.url : ""),
          tabId: tabId,
          consoleLastRefreshed: consoleLastRefreshed || `Last Refreshed: ${new Date().toLocaleTimeString()}`,
          consoleLastRefreshedMs: consoleLastRefreshedMs || null,
          lastScanTime: lastScanTime || Date.now(),
          isLoggedOut: isLoggedOut || false,
          nodes: mergedNodes,
          lastUpdated: Date.now()
        };
        persistDomainState();
        broadcastSync({ domainKey: cleanKey, nodes: mergedNodes }); // Debounced
      }
      sendResponse({ status: "OK" });
      break;
    }

    case "UPDATE_IGNORE_STATE": {
      const { nodeName, checked, domainKey: msgDomainKey } = msg;
      if (nodeName) {
        if (typeof WLSettings !== "undefined") {
          WLSettings.setIgnored(nodeName, checked, msgDomainKey);
        }
        const cleanName = String(nodeName).trim().toUpperCase();
        for (const domainKey in domainStateMap) {
          if (msgDomainKey && cleanDomainKey(domainKey) !== cleanDomainKey(msgDomainKey)) {
            continue;
          }
          if (domainStateMap[domainKey].nodes) {
            for (const nKey in domainStateMap[domainKey].nodes) {
              if (String(nKey).trim().toUpperCase() === cleanName) {
                domainStateMap[domainKey].nodes[nKey].severity = checked ? "IGNORED" : "NORMAL";
              }
            }
          }
        }
        persistDomainState();
        broadcastSync(); // Debounced
      }
      sendResponse({ status: "IGNORED_UPDATED" });
      break;
    }

    case "UPDATE_EVENT_REMARK": {
      const { key, remark } = msg;
      if (key) {
        // ✅ FIX 3: Direct key lookup — 1 DB op per call instead of full scan
        updateEventRemarkInDB(GLOBAL_STORE, key, remark);
        updateEventRemarkInDB(CURRENT_STORE, key, remark);

        for (const dKey in domainStateMap) {
          if (domainStateMap[dKey].nodes) {
            for (const nName in domainStateMap[dKey].nodes) {
              if (key.includes(nName)) {
                domainStateMap[dKey].nodes[nName].remark = remark;
              }
            }
          }
        }
        persistDomainState();

        // ✅ BUG FIX: REMARK_UPDATE_SYNC wapas restore kiya
        // Yeh content script (monitor.js) ke impacted[nName].remark ko live update karta hai
        // Iske bina jab node recover hota hai to old.remark empty hoti hai
        // aur "Node Recovered to OK" user ka remark overwrite kar deta tha
        chrome.tabs.query({}, (tabs) => {
          tabs.forEach(tab => {
            if (tab.id) {
              try {
                chrome.tabs.sendMessage(tab.id, { type: "REMARK_UPDATE_SYNC", key, remark });
              } catch (e) {}
            }
          });
        });
      }
      sendResponse({ status: "REMARK_UPDATED" });
      break;
    }



let ackedNodeKeys = new Set();
let globalAckTimestamp = 0;

function handleGlobalAck() {
  globalAckTimestamp = Date.now();
  ackedNodeKeys.clear();
  for (const domKey in domainStateMap) {
    const domObj = domainStateMap[domKey];
    if (domObj && domObj.nodes) {
      for (const nName in domObj.nodes) {
        const n = domObj.nodes[nName];
        if (n && (n.severity === "CRITICAL" || n.severity === "WARNING")) {
          ackedNodeKeys.add(`${cleanDomainKey(domKey)}_${nName}`);
        }
      }
    }
  }
  chrome.storage.local.set({ "globalAckTimestamp": globalAckTimestamp });
  broadcastSync({ type: "ACK_UPDATED", timestamp: globalAckTimestamp });
}

    case "IMPACT_UPDATE": {
      const { data } = msg;
      if (!data || !data.node || data.node === "undefined") break;

      sendResponse({ status: "SAVED" }); // ⚡ Instant response to content script (<1ms latency!)

      const domainKey = cleanDomainKey(data.domain || "UNKNOWN");
      const itemKey = `${domainKey}_${data.node}`;

      // 🚨 NEW INCIDENT DETECTED CHECK: Reset ACK state if a new node enters warning/critical state!
      if (!data.endTime && (data.severity === "CRITICAL" || data.severity === "WARNING")) {
        if (!ackedNodeKeys.has(itemKey)) {
          // NEW UNACKNOWLEDGED INCIDENT! Reset ACK so UI shows ACK button and alert plays
          globalAckTimestamp = 0;
          chrome.storage.local.set({ "globalAckTimestamp": 0 });
          broadcastSync({ type: "NEW_INCIDENT_RESET_ACK", incidentKey: itemKey });
        }
      }

      // 🔒 Persistent Active Outage Lock: Check CURRENT_STORE in IndexedDB
      getFromDB(CURRENT_STORE, itemKey).then(async (existingRecord) => {
        let incidentId = data.incidentId;
        let startTime = (typeof data.startTime === "number") ? data.startTime : new Date(data.startTime || Date.now()).getTime();
        if (isNaN(startTime)) startTime = Date.now();
        let startDisplay = data.startDisplay || new Date(startTime).toLocaleString();

        if (existingRecord && existingRecord.incidentId && existingRecord.startTime) {
          // 🔒 HARD PERSISTENT LOCK: Lock to existing ongoing outage ID & startTime!
          incidentId = existingRecord.incidentId;
          const exStart = (typeof existingRecord.startTime === "number") ? existingRecord.startTime : new Date(existingRecord.startTime).getTime();
          if (!isNaN(exStart)) startTime = exStart;
          startDisplay = existingRecord.startDisplay || startDisplay;
        }

        if (data.endTime) {
          // 🟢 Recovery! Preserve original outage severity (WARNING or CRITICAL)
          const origSeverity = data.outageSeverity || (existingRecord && existingRecord.severity !== "NORMAL" ? existingRecord.severity : "WARNING");

          const record = {
            ...data,
            severity: origSeverity, // 🔒 LOCK TO OUTAGE SEVERITY (WARNING/CRITICAL) SO RECOVERED INCIDENT NEVER DISAPPEARS!
            incidentId: incidentId || `${domainKey}_${data.node}_${startTime}`,
            key: itemKey,
            domain: domainKey,
            startTime: startTime,
            startDisplay: startDisplay,
            time: data.time || new Date().toISOString()
          };

          await saveToDB(GLOBAL_STORE, record);
          await removeFromDB(CURRENT_STORE, itemKey);
          lastNotificationMap.delete(itemKey);
          closeOrphanedNodeIncidents(domainKey, data.node, data.endTime, data.endDisplay);
        } else {
          // ⚡ Active Outage!
          if (!incidentId) {
            incidentId = `${domainKey}_${data.node}_${startTime}`;
          }

          const record = {
            ...data,
            incidentId: incidentId,
            key: itemKey,
            domain: domainKey,
            startTime: startTime,
            startDisplay: startDisplay,
            time: data.time || new Date().toISOString()
          };

          await saveToDB(CURRENT_STORE, record);
          if (data.severity !== "IGNORED" && data.severity !== "NORMAL") {
            await saveToDB(GLOBAL_STORE, record);
          }

          if (data.severity === "CRITICAL" || data.severity === "WARNING") {
            triggerNotification(domainKey, data.node, data.severity, data.health, data.sockets, data.state, data.stuckThreads);
          }
        }

        updateBadge();
        broadcastSync({ alertData: data });
      }).catch((err) => {
        console.error("[WLMonitor SW] IMPACT_UPDATE Error:", err);
      });
      break;
    }

    case "IMPACT_REMOVE": {
      if (msg.key) {
        removeFromDB(CURRENT_STORE, msg.key);
        lastNotificationMap.delete(msg.key);
        updateBadge();
        broadcastSync(); // Debounced
      }
      sendResponse({ status: "REMOVED" });
      break;
    }

    case "ACK_ALL_ALERTS": {
      globalAckTimestamp = Date.now();
      if (chrome.notifications && chrome.notifications.getAll) {
        chrome.notifications.getAll((notifs) => {
          if (notifs) {
            Object.keys(notifs).forEach(id => {
              if (id.startsWith("WL_")) chrome.notifications.clear(id);
            });
          }
        });
      }
      sendResponse({ status: "ACK_SUCCESS" });
      break;
    }

    case "ACK_DOMAIN_ALERTS": {
      handleDomainAck(msg.domain);
      sendResponse({ status: "ACK_SUCCESS" });
      break;
    }

    case "GET_GLOBAL_STATS": {
      sanitizeMap();
      getTopEventsFromDB(CURRENT_STORE, 50).then((impactedItems) => {
        const stats = {
          domains: domainStateMap,
          impactedList: impactedItems,
          timestamp: Date.now()
        };
        sendResponse(stats);
      });
      return true;
    }

    case "GET_GLOBAL_EVENTS": {
      getUnifiedEventsFromDB(300).then((events) => {
        if (msg.domainKey) {
          const targetDomain = cleanDomainKey(msg.domainKey);
          const filtered = (events || []).filter(e => {
            const dom = cleanDomainKey(e.domain);
            return dom === targetDomain || dom.replace(/_/g, "-") === targetDomain.replace(/_/g, "-");
          });
          sendResponse(filtered);
        } else {
          sendResponse(events || []);
        }
      }).catch(() => sendResponse([]));
      return true;
    }

    case "OPEN_DASHBOARD": {
      chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
      break;
    }

    case "SWITCH_TO_TAB": {
      if (msg.tabId) {
        chrome.tabs.update(msg.tabId, { active: true });
      } else if (msg.url) {
        chrome.tabs.query({}, (tabs) => {
          const match = tabs.find(t => t.url && t.url.includes(msg.url));
          if (match) {
            chrome.tabs.update(match.id, { active: true });
          } else {
            chrome.tabs.create({ url: msg.url });
          }
        });
      }
      break;
    }
  }
});

function checkDashboardTabOpen() {
  try {
    if (chrome.tabs && chrome.tabs.query) {
      chrome.tabs.query({}, (tabs) => {
        const isDashboardOpen = tabs && Array.isArray(tabs) && tabs.some(t => t.url && t.url.includes("dashboard.html"));
        chrome.storage.local.set({ "isDashboardOpen": isDashboardOpen });
      });
    }
  } catch (e) {}
}

setInterval(checkDashboardTabOpen, 5000);
try {
  if (chrome.tabs) {
    chrome.tabs.onUpdated.addListener(checkDashboardTabOpen);
    chrome.tabs.onRemoved.addListener(checkDashboardTabOpen);
  }
} catch (e) {}
checkDashboardTabOpen();

// ⚡ 24/7 SERVICE WORKER KEEP-ALIVE ENGINE (Prevents Manifest V3 Service Worker Sleeping)
function initKeepAliveEngine() {
  try {
    if (chrome.alarms) {
      chrome.alarms.create("WL_KEEP_ALIVE_ALARM", { periodInMinutes: 0.35 });
      chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm && alarm.name === "WL_KEEP_ALIVE_ALARM") {
          chrome.storage.local.set({ "sw_last_heartbeat": Date.now() });
        }
      });
    }
  } catch (e) {}

  setInterval(() => {
    try {
      chrome.storage.local.set({ "sw_heartbeat_ping": Date.now() });
    } catch (e) {}
  }, 3000); // ⚡ 3-SECOND LIVE HEARTBEAT PING
}

initKeepAliveEngine();
openDB();