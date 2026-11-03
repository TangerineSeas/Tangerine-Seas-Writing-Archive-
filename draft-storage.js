/* ==========================================================================
   admin/draft-storage.js
   第三阶段：用 IndexedDB 在本浏览器保存草稿
   第五阶段：增加「已发布作品目录」存储（works），用于生成 works.json

   草稿只存在这台设备的浏览器里，不会同步到云端，也不会自动进入 GitHub。
   清空浏览器数据 / 换设备都会导致草稿丢失，重要内容请用「导出备份」。

   drafts 一条记录：
     id, title, number, date, form, fileName, fileType, fileSize,
     fileBlob(原始 DOCX), bodyHtml, createdAt, updatedAt, status

   works 一条记录（已进目录的作品，等价于 works.json 里的一项）：
     id, number, title, date, form, chars, contentFile, sourceFile,
     publishedAt, updatedAt, source("local" | "remote")
   ========================================================================== */

(function (global) {
  "use strict";

  var DB_NAME = "ts-archive";
  var DB_VERSION = 2;          // v2 起增加 works 表
  var DRAFT_STORE = "drafts";
  var WORK_STORE = "works";

  var _db = null;

  /* ============================ 基础 ============================ */

  /** 浏览器是否支持 IndexedDB（file:// 或隐私模式下可能不可用） */
  function supported() {
    try {
      return !!global.indexedDB;
    } catch (e) {
      return false;
    }
  }

  function open() {
    if (_db) return Promise.resolve(_db);

    if (!supported()) {
      return Promise.reject(new Error("这个浏览器不支持 IndexedDB。"));
    }

    return new Promise(function (resolve, reject) {
      var req;
      try {
        req = global.indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        // 部分浏览器在 file:// 下会直接抛 SecurityError
        reject(e);
        return;
      }

      req.onupgradeneeded = function () {
        var db = req.result;

        if (!db.objectStoreNames.contains(DRAFT_STORE)) {
          var drafts = db.createObjectStore(DRAFT_STORE, { keyPath: "id" });
          drafts.createIndex("updatedAt", "updatedAt", { unique: false });
        }

        if (!db.objectStoreNames.contains(WORK_STORE)) {
          var works = db.createObjectStore(WORK_STORE, { keyPath: "id" });
          works.createIndex("number", "number", { unique: false });
        }
      };

      req.onsuccess = function () {
        _db = req.result;
        _db.onversionchange = function () {
          _db.close();
          _db = null;
        };
        resolve(_db);
      };

      req.onerror = function () {
        reject(req.error || new Error("无法打开本地数据库。"));
      };

      req.onblocked = function () {
        reject(new Error("数据库被其他标签页占用，请关掉多余的页面后重试。"));
      };
    });
  }

  /* ============================ 通用读写 ============================ */

  function putIn(storeName, record) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(storeName, "readwrite");
        t.objectStore(storeName).put(record);
        t.oncomplete = function () { resolve(record); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error("写入被中止。")); };
      });
    });
  }

  function getIn(storeName, id) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction(storeName, "readonly").objectStore(storeName).get(id);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function getAllIn(storeName) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function deleteIn(storeName, id) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(storeName, "readwrite");
        t.objectStore(storeName).delete(id);
        t.oncomplete = function () { resolve(true); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error("删除被中止。")); };
      });
    });
  }

  function clearIn(storeName) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(storeName, "readwrite");
        t.objectStore(storeName).clear();
        t.oncomplete = function () { resolve(true); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }

  /* ============================ 草稿 API ============================ */

  function put(draft) { return putIn(DRAFT_STORE, draft); }
  function get(id) { return getIn(DRAFT_STORE, id); }
  function remove(id) { return deleteIn(DRAFT_STORE, id); }
  function clear() { return clearIn(DRAFT_STORE); }

  /** 按最近修改时间倒序列出全部草稿 */
  function list() {
    return getAllIn(DRAFT_STORE).then(function (rows) {
      rows.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
      return rows;
    });
  }

  /* ============================ 作品目录 API ============================ */

  function putWork(work) { return putIn(WORK_STORE, work); }
  function getWork(id) { return getIn(WORK_STORE, id); }
  function removeWork(id) { return deleteIn(WORK_STORE, id); }
  function clearWorks() { return clearIn(WORK_STORE); }

  /** 已发布作品，按档案编号升序（编号是定长的，字符串排序即时间顺序） */
  function listWorks() {
    return getAllIn(WORK_STORE).then(function (rows) {
      rows.sort(function (a, b) {
        return String(a.number || "").localeCompare(String(b.number || ""));
      });
      return rows;
    });
  }

  /* ============================ 小工具 ============================ */

  /** 生成草稿 ID */
  function uniqueId() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") {
      return global.crypto.randomUUID();
    }
    return "d-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  /** Blob → base64（去掉 data: 前缀），用于导出备份 */
  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var s = String(reader.result);
        resolve(s.slice(s.indexOf(",") + 1));
      };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsDataURL(blob);
    });
  }

  global.DraftStore = {
    supported: supported,

    // 草稿
    put: put,
    get: get,
    list: list,
    remove: remove,
    clear: clear,

    // 已发布作品目录
    putWork: putWork,
    getWork: getWork,
    listWorks: listWorks,
    removeWork: removeWork,
    clearWorks: clearWorks,

    // 工具
    uniqueId: uniqueId,
    blobToBase64: blobToBase64
  };

})(window);
