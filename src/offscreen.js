// ⚡ 24/7 UNTHROTTLED OFFSCREEN BACKGROUND POLLING ENGINE (MV3 Compliant)
// Guarantees 3-second live background polling even when Chrome tabs are in background or minimized!

function triggerHeartbeat() {
  try {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ type: "POLL_NOW" }, () => {
        if (chrome.runtime.lastError) {}
      });
    }
  } catch (e) {}
}

setInterval(triggerHeartbeat, 3000);
triggerHeartbeat();
