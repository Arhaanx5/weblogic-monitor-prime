// WebLogic Monitor - Persistent Custom Settings Engine (Chrome Storage Sync)
const WLSettings = (() => {
  let isInitialized = false;
  let settings = {
    globalDefaultThreshold: 70,
    scanIntervalSeconds: 10,
    enableSound: true,
    enableNotifications: true,
    alertRepeatMinutes: 5,
    retentionDays: 7,
    isPrivacyMode: false,
    isMaintenanceMode: false,
    webhookUrl: "",
    nonProdKeywords: "",
    prodPorts: "7001",
    prodSubnets: "172.16.",
    threshold: {},
    ignore: []
  };

  function init() {
    try {
      if (chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(["WLMonitorSettings"], (res) => {
          if (res && res.WLMonitorSettings) {
            const remote = res.WLMonitorSettings;
            settings.globalDefaultThreshold = remote.globalDefaultThreshold || 70;
            settings.scanIntervalSeconds = remote.scanIntervalSeconds || 10;
            settings.enableSound = remote.enableSound !== undefined ? remote.enableSound : true;
            settings.enableNotifications = remote.enableNotifications !== undefined ? remote.enableNotifications : true;
            settings.alertRepeatMinutes = remote.alertRepeatMinutes || 5;
            settings.retentionDays = remote.retentionDays || 7;
            settings.isPrivacyMode = remote.isPrivacyMode === true;
            settings.isMaintenanceMode = remote.isMaintenanceMode === true;
            settings.webhookUrl = remote.webhookUrl || "";
            settings.nonProdKeywords = remote.nonProdKeywords || "";
            settings.prodPorts = remote.prodPorts || "7001";
            settings.prodSubnets = remote.prodSubnets || "172.16.";
            settings.threshold = remote.threshold ? { ...remote.threshold } : {};
            settings.ignore = Array.isArray(remote.ignore) ? [...remote.ignore] : [];
          }
          isInitialized = true;
          console.log("[WLSettings] Fully initialized central settings from chrome.storage.local:", settings);
        });

        // 🚨 REALTIME STORAGE CHANGE LISTENER across all tabs & origins
        chrome.storage.onChanged.addListener((changes, areaName) => {
          if (areaName === "local" && changes.WLMonitorSettings && changes.WLMonitorSettings.newValue) {
            const remote = changes.WLMonitorSettings.newValue;
            settings.globalDefaultThreshold = remote.globalDefaultThreshold || 70;
            settings.scanIntervalSeconds = remote.scanIntervalSeconds || 10;
            settings.enableSound = remote.enableSound !== undefined ? remote.enableSound : true;
            settings.enableNotifications = remote.enableNotifications !== undefined ? remote.enableNotifications : true;
            settings.alertRepeatMinutes = remote.alertRepeatMinutes || 5;
            settings.retentionDays = remote.retentionDays || 7;
            settings.isPrivacyMode = remote.isPrivacyMode === true;
            settings.isMaintenanceMode = remote.isMaintenanceMode === true;
            settings.webhookUrl = remote.webhookUrl || "";
            settings.nonProdKeywords = remote.nonProdKeywords || "";
            settings.prodPorts = remote.prodPorts || "7001";
            settings.prodSubnets = remote.prodSubnets || "172.16.";
            settings.threshold = remote.threshold ? { ...remote.threshold } : {};
            settings.ignore = Array.isArray(remote.ignore) ? [...remote.ignore] : [];
            console.log("[WLSettings] Realtime synced settings change across tabs:", settings);
          }
        });
      } else {
        isInitialized = true;
      }
    } catch (e) {
      console.error("Settings load error:", e);
      isInitialized = true;
    }
  }

  function save() {
    try {
      if (!Array.isArray(settings.ignore)) settings.ignore = [];
      try { localStorage.removeItem("WLMonitor_Global_Custom_Settings"); } catch(e){}

      // Sync settings to chrome.storage.local for background service worker & all tabs
      if (chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ "WLMonitorSettings": settings }, () => {
          console.log("[WLSettings] Saved settings to chrome.storage.local:", settings);
        });
      }
    } catch (e) {
      console.error("Settings save error:", e);
    }
  }

  function getThreshold(nodeName, domainKey) {
    if (!nodeName) return Number(settings.globalDefaultThreshold || 70);
    const cleanName = String(nodeName).trim();
    const cleanNameUpper = cleanName.toUpperCase();
    const baseUpper = cleanName.replace(/\(.*\)/g, "").trim().toUpperCase();
    const domainUpper = domainKey ? String(domainKey).trim().toUpperCase() : "";

    if (settings.threshold) {
      if (domainUpper) {
        const scopedKeyUpper = `${domainUpper}_${cleanNameUpper}`;
        const scopedBaseUpper = baseUpper ? `${domainUpper}_${baseUpper}` : "";
        for (const k in settings.threshold) {
          const kUpper = String(k).trim().toUpperCase();
          if (kUpper === scopedKeyUpper || (scopedBaseUpper && kUpper === scopedBaseUpper)) {
            const val = settings.threshold[k];
            if (val !== undefined && val !== "") return Number(val);
          }
        }
      }
      for (const k in settings.threshold) {
        const kUpper = String(k).trim().toUpperCase();
        if (kUpper === cleanNameUpper || (baseUpper && kUpper === baseUpper)) {
          const val = settings.threshold[k];
          if (val !== undefined && val !== "") return Number(val);
        }
      }
    }

    return Number(settings.globalDefaultThreshold || 70);
  }

  function setThreshold(nodeName, value, domainKey) {
    if (!nodeName) return;
    const cleanName = String(nodeName).trim();
    if (!settings.threshold) settings.threshold = {};
    if (domainKey) {
      const scopedKey = `${String(domainKey).trim().toUpperCase()}_${cleanName}`;
      settings.threshold[scopedKey] = Number(value);
    } else {
      settings.threshold[cleanName] = Number(value);
    }
    save();
  }

  function isIgnored(nodeName, domainKey) {
    if (!Array.isArray(settings.ignore) || !nodeName) return false;
    const cleanName = String(nodeName).trim().toUpperCase();
    const baseUpper = cleanName.replace(/\(.*\)/g, "").trim().toUpperCase();

    if (domainKey) {
      const scopedKey = `${String(domainKey).trim().toUpperCase()}_${cleanName}`;
      const scopedBaseKey = baseUpper ? `${String(domainKey).trim().toUpperCase()}_${baseUpper}` : "";
      return settings.ignore.some(n => {
        const nUpper = String(n).trim().toUpperCase();
        return nUpper === scopedKey || (scopedBaseKey && nUpper === scopedBaseKey);
      });
    }

    return settings.ignore.some(n => {
      const nUpper = String(n).trim().toUpperCase();
      return nUpper === cleanName || (baseUpper && nUpper === baseUpper);
    });
  }

  function setIgnored(nodeName, isIgnoredFlag, domainKey) {
    if (!Array.isArray(settings.ignore)) settings.ignore = [];
    if (!nodeName) return;
    const cleanName = String(nodeName).trim();
    const targetKey = domainKey ? `${String(domainKey).trim()}_${cleanName}` : cleanName;

    if (isIgnoredFlag) {
      if (!isIgnored(cleanName, domainKey)) {
        settings.ignore.push(targetKey);
      }
    } else {
      const targetUpper = targetKey.toUpperCase();
      const cleanUpper = cleanName.toUpperCase();
      const baseUpper = cleanName.replace(/\(.*\)/g, "").trim().toUpperCase();

      settings.ignore = settings.ignore.filter(n => {
        const nUpper = String(n).trim().toUpperCase();
        return nUpper !== targetUpper && nUpper !== cleanUpper && (baseUpper && nUpper !== baseUpper);
      });
    }
    save();
  }

  function updateGlobalSettings(newConfig) {
    settings = { ...settings, ...newConfig };
    save();
  }

  function getAll() {
    return settings;
  }

  function reset() {
    settings = {
      globalDefaultThreshold: 70,
      scanIntervalSeconds: 10,
      enableSound: true,
      enableNotifications: true,
      alertRepeatMinutes: 5,
      retentionDays: 7,
      threshold: {},
      ignore: []
    };
    save();
  }

  return {
    init,
    save,
    getThreshold,
    setThreshold,
    isIgnored,
    setIgnored,
    toggleIgnore: setIgnored, // ✅ FIX 1: dashboard.js Un-Ignore button isko call karta hai
    updateGlobalSettings,
    getAll,
    reset
  };
})();

const globalScope = typeof window !== "undefined" ? window : (typeof self !== "undefined" ? self : globalThis);
globalScope.WLSettings = WLSettings;
WLSettings.init();