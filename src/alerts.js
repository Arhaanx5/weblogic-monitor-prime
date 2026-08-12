const WLAlerts = (() => {
  let nodeState = {};
  let muted = false;
  let audioCtx = null;

  const DEFAULT_REPEAT = 300000; // 5 minutes

  function isMaintenanceModeActive() {
    try {
      if (window.WLSettings) {
        const cfg = window.WLSettings.getAll();
        if (cfg && cfg.isMaintenanceMode === true) return true;
      }
    } catch (e) {}
    return false;
  }

  function initNode(node) {
    if (!nodeState[node]) {
      nodeState[node] = {
        ack: false,
        lastAlert: 0,
        severity: null
      };
    }
  }

  function update(node, severity) {
    initNode(node);
    nodeState[node].severity = severity;
    const now = Date.now();

    if (severity === "NORMAL") {
      clear(node);
      return;
    }

    if (canAlert(node) && !muted && !isMaintenanceModeActive()) {
      playSound();
      nodeState[node].lastAlert = now;
    }
  }

  function canAlert(node) {
    const data = nodeState[node];
    if (!data) return true;
    if (data.ack) return false;
    return Date.now() - data.lastAlert > DEFAULT_REPEAT;
  }

  function acknowledge(node) {
    initNode(node);
    nodeState[node].ack = true;
  }

  function acknowledgeAll() {
    Object.keys(nodeState).forEach((node) => {
      nodeState[node].ack = true;
    });
  }

  function resetAck(node) {
    if (nodeState[node]) {
      nodeState[node].ack = false;
    }
  }

  function clear(node) {
    delete nodeState[node];
  }

  function mute(state) {
    muted = state;
  }

  function getAudioContext() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }
    return audioCtx;
  }

  let isDashboardOpen = false;

  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(["isDashboardOpen"], (res) => {
        if (res && res.isDashboardOpen === true) isDashboardOpen = true;
      });

      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === "local" && changes.isDashboardOpen) {
          isDashboardOpen = changes.isDashboardOpen.newValue === true;
        }
      });
    }
  } catch (e) {}

  function playSound() {
    // 🛡️ STEP 2 RULE: If NOC Dashboard is open in any tab, MUTE sound on all individual WebLogic tabs completely!
    if (isDashboardOpen) {
      console.log("[WLAlerts] Muted on individual tab because NOC Dashboard is OPEN.");
      return;
    }

    if (muted || isMaintenanceModeActive()) return;
    try {
      const ctx = getAudioContext();
      let t = ctx.currentTime;
      for (let n = 0; n < 3; n++) {
        let osc = ctx.createOscillator();
        let gain = ctx.createGain();
        osc.type = "square";
        osc.frequency.value = 500;
        gain.gain.value = 0.3;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.25);
        t += 0.4;
      }
    } catch (e) {}
  }

  function unlockAudio() {
    try {
      const ctx = getAudioContext();
      if (ctx.state === "suspended") {
        ctx.resume();
      }
    } catch (e) {}
  }

  function getState() {
    return nodeState;
  }

  return {
    update,
    acknowledge,
    acknowledgeAll,
    resetAck,
    clear,
    mute,
    setMuted: mute,
    getState,
    unlockAudio,
    playSound
  };
})();

window.WLAlerts = WLAlerts;