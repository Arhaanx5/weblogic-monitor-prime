const WLStorage = (() => {
  const DB_NAME = "WLMonitorDB_V5";
  const DB_VERSION = 1;

  const NODE_HISTORY = "nodeHistory";
  const ALL_EVENTS = "allEvents";
  const REMARKS = "remarks";

  let db = null;

  function cleanDomainKey(key) {
    if (!key) return "UNKNOWN";
    let cleaned = String(key).replace(/(\d{1,3}\.){3}\d{1,3}_?/g, "").trim();
    cleaned = cleaned.replace(/-/g, "_").replace(/_+/g, "_").replace(/_$/, "").replace(/^TCL\s+/, "TCL_").replace(/^HFL\s+/, "HFL_");
    if (/(CMS|GCD|ECM|NIF)/gi.test(cleaned)) {
      cleaned = cleaned.replace(/(CMS|GCD|ECM|NIF)/gi, "INTG");
    }
    return cleaned || key;
  }

  function getDomainKey() {
    if (window.WLMonitorEngine && window.WLMonitorEngine.getDomainKey) {
      return cleanDomainKey(window.WLMonitorEngine.getDomainKey());
    }
    return cleanDomainKey(window.location.hostname || "UNKNOWN");
  }

  function openDB() {
    return new Promise((resolve, reject) => {
      if (db) {
        resolve(db);
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = e => {
        const database = e.target.result;

        // 🧹 Auto-Wipe legacy stores for clean V4 schema
        ["nodeHistory", "allEvents", "remarks", "currentImpacted", "globalImpacted"].forEach(storeName => {
          if (database.objectStoreNames.contains(storeName)) {
            try { database.deleteObjectStore(storeName); } catch (err) {}
          }
        });

        const store = database.createObjectStore(NODE_HISTORY, { keyPath: "id", autoIncrement: true });
        store.createIndex("time", "time");
        store.createIndex("domain", "domain");
        store.createIndex("incidentId", "incidentId");

        const allStore = database.createObjectStore(ALL_EVENTS, { keyPath: "id", autoIncrement: true });
        allStore.createIndex("time", "time");
        allStore.createIndex("domain", "domain");

        const remStore = database.createObjectStore(REMARKS, { keyPath: "id", autoIncrement: true });
        remStore.createIndex("time", "time");
        remStore.createIndex("domain", "domain");
      };

      request.onsuccess = e => {
        db = e.target.result;
        console.log("WLStorage Ready");
        resolve(db);
      };

      request.onerror = e => {
        console.error("WLStorage Error", e.target.error);
        reject(e.target.error);
      };
    });
  }

  async function add(storeName, data) {
    const database = await openDB();

    return new Promise((resolve, reject) => {
      try {
        const tx = database.transaction(storeName, "readwrite");
        const currentDomain = getDomainKey();

        const item = {
          ...data,
          domain: data.domain ? cleanDomainKey(data.domain) : currentDomain,
          time: data.time || new Date().toISOString()
        };

        tx.objectStore(storeName).add(item);

        tx.oncomplete = () => {
          resolve(true);
        };

        tx.onerror = e => {
          console.error("Storage Insert Error", e.target.error);
          reject(e.target.error);
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  async function getAll(storeName) {
    return new Promise((resolve) => {
      try {
        const currentDomain = getDomainKey();
        const filterDomain = (storeName === NODE_HISTORY) ? currentDomain : null;
        chrome.runtime.sendMessage({ type: "GET_GLOBAL_EVENTS", domainKey: filterDomain }, (res) => {
          if (Array.isArray(res)) {
            resolve(res);
          } else {
            resolve([]);
          }
        });
      } catch (e) {
        resolve([]);
      }
    });
  }

  async function clear(storeName) {
    const database = await openDB();

    return new Promise(resolve => {
      const tx = database.transaction(storeName, "readwrite");
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => {
        resolve(true);
      };
    });
  }

  function saveSettings(settings) {
    const key = "WLMonitor::" + getDomainKey();
    localStorage.setItem(key, JSON.stringify(settings));
  }

  function loadSettings() {
    const key = "WLMonitor::" + getDomainKey();
    const data = localStorage.getItem(key);
    return data ? JSON.parse(data) : null;
  }

  return {
    STORES: {
      NODE_HISTORY: NODE_HISTORY,
      ALL_EVENTS: ALL_EVENTS,
      REMARKS: REMARKS
    },
    openDB,  // ✅ FIX 2: cleanup.js window.WLStorage.openDB() call ke liye expose kiya
    add,
    getAll,
    clear,
    saveSettings,
    loadSettings,
    getDomainKey
  };
})();

window.WLStorage = WLStorage;