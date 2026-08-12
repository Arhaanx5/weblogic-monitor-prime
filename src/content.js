(() => {
  let isScanning = false;

  console.log("[WLMonitor Content Script] High-Performance Engine Loaded on:", location.href);

  function findTable() {
    const primary = document.querySelector("#genericTableFormtable");
    if (primary) return primary;

    const rowMatch = document.querySelector("tr.rowEven, tr.rowOdd");
    if (rowMatch) return rowMatch.closest("table");

    return null;
  }

  function getColumns(table) {
    const map = {};
    table.querySelectorAll("th").forEach((th, index) => {
      const text = th.innerText.trim().toUpperCase();
      if (text) map[text] = index;
    });

    const nameCol = findColumn(map, ["NAME", "SERVER"]);
    const healthCol = findColumn(map, ["HEALTH"]);
    const socketCol = findColumn(map, ["TOTAL SOCKETS", "OPEN SOCKET", "SOCKET"]);
    const stateCol = findColumn(map, ["STATE", "STATUS"]);
    const stuckCol = findColumn(map, ["STUCK", "HOGGING", "THREAD"]);

    return { nameCol, healthCol, socketCol, stateCol, stuckCol };
  }

  function findColumn(map, names) {
    for (const key in map) {
      for (const name of names) {
        if (key.includes(name)) return map[key];
      }
    }
    return -1;
  }

  function isControlTab(table) {
    if (!table) return false;
    const form = table.closest("form");
    if (form && form.name && form.name.toLowerCase().includes("control")) {
      return true;
    }
    const pageTitle = (document.querySelector(".title, h1, .pageTitle")?.innerText || "").toLowerCase();
    if (pageTitle.includes("control") && !pageTitle.includes("summary")) {
      return true;
    }
    return false;
  }

  function readNodes() {
    const table = findTable();
    if (!table) return [];

    // STEP 1 RULE: If user is on Control Tab, return empty array [] immediately!
    if (isControlTab(table)) {
      return [];
    }

    const { nameCol, healthCol, socketCol, stateCol, stuckCol } = getColumns(table);
    
    // 🛡️ STRICT CHECK: Table MUST have both Name AND Health columns! If Health column is missing, skip scanning to preserve outages.
    if (nameCol < 0 || healthCol < 0) {
      return [];
    }

    const rows = table.querySelectorAll("tr.rowEven, tr.rowOdd");
    const nodes = [];

    for (let i = 0; i < rows.length; i++) {
      const cells = rows[i].querySelectorAll("td");
      if (!cells.length) continue;

      const name = cells[nameCol]?.innerText?.trim();
      if (!name) continue;

      const socketText = (socketCol >= 0 && cells[socketCol]) ? cells[socketCol].innerText?.trim() : "0";
      const parsedSockets = parseInt((socketText || "0").replace(/[^0-9]/g, ""), 10) || 0;

      const healthVal = (healthCol >= 0 && cells[healthCol]) ? (cells[healthCol].innerText?.trim() || "OK") : "OK";
      const stateVal = (stateCol >= 0 && cells[stateCol]) ? (cells[stateCol].innerText?.trim() || "RUNNING") : "RUNNING";

      nodes.push({
        name,
        health: healthVal,
        sockets: parsedSockets,
        state: stateVal,
        stuckThreads: (stuckCol >= 0 && cells[stuckCol]) ? cells[stuckCol].innerText?.trim() : "",
        remark: ""
      });
    }

    return nodes;
  }

  function safeScan() {
    if (isScanning) return;
    isScanning = true;

    try {
      if (window.WLMonitorEngine) {
        const nodes = readNodes();
        if (nodes.length > 0) {
          window.WLMonitorEngine.process(nodes);
        }
      }
      if (window.WLUI) {
        window.WLUI.render();
      }
    } catch (e) {
      console.error("[WLMonitor] Safe scan error:", e);
    } finally {
      isScanning = false;
    }
  }

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === "FORCE_SCAN") {
        safeScan();
        sendResponse({ status: "SCANNED" });
      }
    });
  } catch (e) {}

  safeScan();
  setInterval(safeScan, 10000);
})();