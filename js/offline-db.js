/* Kahera POS — local offline database foundation.
 * This module only provides durable local storage primitives. Transaction
 * capture and synchronization are integrated in later implementation steps.
 */
(function (root) {
  "use strict";

  var DB_NAME = "kahera-offline";
  var DB_VERSION = 1;
  var STORES = {
    menu: "menu",
    settings: "settings",
    transactions: "transactions",
    meta: "meta"
  };
  var dbPromise = null;

  function open() {
    if (!root.indexedDB) {
      return Promise.reject(new Error("This browser does not support local offline storage."));
    }
    if (dbPromise) return dbPromise;

    dbPromise = new Promise(function (resolve, reject) {
      var request = root.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function () {
        var db = request.result;
        Object.keys(STORES).forEach(function (key) {
          var name = STORES[key];
          if (!db.objectStoreNames.contains(name)) {
            var options = { keyPath: "id" };
            var store = db.createObjectStore(name, options);
            if (name === STORES.transactions) {
              store.createIndex("syncStatus", "syncStatus", { unique: false });
              store.createIndex("createdAt", "createdAt", { unique: false });
            }
          }
        });
      };
      request.onsuccess = function () {
        var db = request.result;
        db.onversionchange = function () {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = function () {
        dbPromise = null;
        reject(request.error || new Error("Could not open local offline storage."));
      };
      request.onblocked = function () {
        reject(new Error("Local offline storage is busy in another Kahera tab. Close other tabs and retry."));
      };
    });
    return dbPromise;
  }

  function run(storeName, mode, action) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var transaction = db.transaction(storeName, mode);
        var request;
        try {
          request = action(transaction.objectStore(storeName));
        } catch (error) {
          reject(error);
          return;
        }
        transaction.oncomplete = function () {
          resolve(request ? request.result : undefined);
        };
        transaction.onerror = transaction.onabort = function () {
          reject(transaction.error || (request && request.error) || new Error("Local storage operation failed."));
        };
      });
    });
  }

  function validStore(name) {
    if (Object.keys(STORES).every(function (key) { return STORES[key] !== name; })) {
      throw new Error("Unknown Kahera offline storage collection.");
    }
    return name;
  }

  root.KaheraOfflineDB = {
    open: open,
    put: function (store, record) {
      validStore(store);
      if (!record || typeof record.id !== "string" || !record.id) {
        return Promise.reject(new Error("A local record must have a string ID."));
      }
      return run(store, "readwrite", function (objectStore) {
        return objectStore.put(record);
      });
    },
    get: function (store, id) {
      validStore(store);
      return run(store, "readonly", function (objectStore) {
        return objectStore.get(id);
      });
    },
    getAll: function (store) {
      validStore(store);
      return run(store, "readonly", function (objectStore) {
        return objectStore.getAll();
      });
    },
    remove: function (store, id) {
      validStore(store);
      return run(store, "readwrite", function (objectStore) {
        return objectStore.delete(id);
      });
    },
    clear: function (store) {
      validStore(store);
      return run(store, "readwrite", function (objectStore) {
        return objectStore.clear();
      });
    },
    savePendingTransaction: function (transactionRecord) {
      if (!transactionRecord || typeof transactionRecord.id !== "string" || !transactionRecord.id) {
        return Promise.reject(new Error("A transaction must have a stable ID before it can be queued."));
      }
      var record = Object.assign({}, transactionRecord, {
        syncStatus: "pending",
        queuedAt: transactionRecord.queuedAt || new Date().toISOString(),
        attempts: Number(transactionRecord.attempts) || 0
      });
      return run(STORES.transactions, "readwrite", function (objectStore) {
        return objectStore.put(record);
      });
    },
    getPendingTransactions: function () {
      return run(STORES.transactions, "readonly", function (objectStore) {
        return objectStore.index("syncStatus").getAll("pending");
      });
    },
    updateTransaction: function (id, changes) {
      if (typeof id !== "string" || !id) return Promise.reject(new Error("A transaction ID is required."));
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(STORES.transactions, "readwrite");
          var objectStore = tx.objectStore(STORES.transactions);
          var request = objectStore.get(id);
          var updated;
          request.onsuccess = function () {
            if (!request.result) {
              tx.abort();
              reject(new Error("The queued transaction could not be found."));
              return;
            }
            updated = Object.assign({}, request.result, changes || {}, { id: id });
            objectStore.put(updated);
          };
          tx.oncomplete = function () { resolve(updated); };
          tx.onerror = tx.onabort = function () {
            reject(tx.error || request.error || new Error("Could not update the queued transaction."));
          };
        });
      });
    },
    stores: Object.freeze({
      menu: STORES.menu,
      settings: STORES.settings,
      transactions: STORES.transactions,
      meta: STORES.meta
    })
  };
})(typeof window !== "undefined" ? window : this);
