document.addEventListener("DOMContentLoaded", () => {
  const openDashboardBtn = document.getElementById("openDashboardBtn");
  const criticalCountElem = document.getElementById("criticalCount");
  const warningCountElem = document.getElementById("warningCount");
  const domainCountElem = document.getElementById("domainCount");
  const domainListElem = document.getElementById("domainList");
  const statusDot = document.getElementById("statusDot");

  openDashboardBtn.addEventListener("click", () => {
    if (chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
    } else {
      chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD" });
    }
  });

  function renderStats() {
    chrome.runtime.sendMessage({ type: "GET_GLOBAL_STATS" }, (response) => {
      if (!response || !response.domains) {
        domainListElem.innerHTML = `<div class="empty-state" style="color:#fca5a5;">⚠️ WebLogic Unreachable<br><span style="font-size:11px;color:#94a3b8;">Please check network connectivity.</span></div>`;
        return;
      }

      const domainsMap = response.domains;
      const domainKeys = Object.keys(domainsMap);

      let totalCritical = 0;
      let totalWarning = 0;

      domainListElem.innerHTML = "";

      if (domainKeys.length === 0) {
        domainListElem.innerHTML = `<div class="empty-state" style="color:#fca5a5;">⚠️ WebLogic Unreachable<br><span style="font-size:11px;color:#94a3b8;">Please check network connectivity.</span></div>`;
        domainCountElem.textContent = "0";
        criticalCountElem.textContent = "0";
        warningCountElem.textContent = "0";
        return;
      }

      domainCountElem.textContent = String(domainKeys.length);

      domainKeys.forEach((key) => {
        const domainObj = domainsMap[key];
        const nodes = domainObj.nodes || {};

        let dCritical = 0;
        let dWarning = 0;

        Object.values(nodes).forEach((n) => {
          if (n.severity === "CRITICAL") {
            dCritical++;
            totalCritical++;
          } else if (n.severity === "WARNING") {
            dWarning++;
            totalWarning++;
          }
        });

        const card = document.createElement("div");
        card.className = "domain-card";

        let statusClass = "healthy";
        let statusText = "HEALTHY";

        if (domainObj.unreachable) {
          statusClass = "critical";
          statusText = "UNREACHABLE";
        } else if (dCritical > 0) {
          statusClass = "critical";
          statusText = `${dCritical} CRITICAL`;
        } else if (dWarning > 0) {
          statusClass = "warning";
          statusText = `${dWarning} WARNING`;
        }

        card.innerHTML = `
          <div class="domain-info">
            <div class="domain-name" title="${key}">${key}</div>
            <div class="domain-sub">${Object.keys(nodes).length} nodes scanned</div>
          </div>
          <span class="badge-pill ${statusClass}">${statusText}</span>
        `;

        card.addEventListener("click", () => {
          if (domainObj.tabId) {
            chrome.runtime.sendMessage({ type: "SWITCH_TO_TAB", tabId: domainObj.tabId });
          } else if (domainObj.url) {
            chrome.runtime.sendMessage({ type: "SWITCH_TO_TAB", url: domainObj.url });
          }
        });

        domainListElem.appendChild(card);
      });

      criticalCountElem.textContent = String(totalCritical);
      warningCountElem.textContent = String(totalWarning);

      if (totalCritical > 0) {
        statusDot.className = "header-icon has-critical";
      } else {
        statusDot.className = "header-icon";
      }
    });
  }

  renderStats();
  setInterval(renderStats, 2000);
});
