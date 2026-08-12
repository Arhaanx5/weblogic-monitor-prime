// WebLogic Monitor - Memory Optimization & Storage Pruning Engine
const WLCleanup = (() => {
  const MAX_RECORDS_CAP = 500; // Cap records in browser IndexedDB to prevent memory load
  const DEFAULT_RETENTION_DAYS = 7;
  let started = false;

  function start() {
    if (started) return;
    started = true;
    cleanAll();
    setInterval(cleanAll, 12 * 60 * 60 * 1000); // Clean every 12 hours
  }

  async function cleanAll() {
    const retentionDays = (window.WLSettings && window.WLSettings.getAll().retentionDays) || DEFAULT_RETENTION_DAYS;

    if (window.WLStorage && window.WLStorage.STORES) {
      await cleanStoreByCutoff(window.WLStorage.STORES.ALL_EVENTS, retentionDays);
      await cleanStoreByCap(window.WLStorage.STORES.ALL_EVENTS, MAX_RECORDS_CAP);

      await cleanStoreByCutoff(window.WLStorage.STORES.NODE_HISTORY, retentionDays * 2);
      await cleanStoreByCap(window.WLStorage.STORES.NODE_HISTORY, MAX_RECORDS_CAP);
    }
  }

  async function cleanStoreByCutoff(storeName, days) {
    try {
      const db = await window.WLStorage.openDB();
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      const index = store.index("time");
      const request = index.openCursor(IDBKeyRange.upperBound(cutoff));

      request.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };

      tx.oncomplete = () => {
        console.log(`WL Memory Pruned (Cutoff ${days}d):`, storeName);
      };
    } catch (err) {
      console.error("Cleanup cutoff error:", storeName, err);
    }
  }

  async function cleanStoreByCap(storeName, maxCap) {
    try {
      const db = await window.WLStorage.openDB();
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      const req = store.getAll();

      req.onsuccess = () => {
        const items = req.result || [];
        if (items.length > maxCap) {
          // Sort ascending by ID to delete oldest excess items
          items.sort((a, b) => a.id - b.id);
          const deleteCount = items.length - maxCap;
          for (let i = 0; i < deleteCount; i++) {
            store.delete(items[i].id);
          }
          console.log(`WL Memory Pruned (Cap ${maxCap}): deleted ${deleteCount} items from`, storeName);
        }
      };
    } catch (err) {
      console.error("Cleanup cap error:", storeName, err);
    }
  }

  return {
    start,
    cleanAll,
    cleanStoreByCutoff,
    cleanStoreByCap
  };
})();

window.WLCleanup = WLCleanup;
WLCleanup.start();