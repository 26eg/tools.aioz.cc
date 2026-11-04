// ==UserScript==
// @name         Amazon 类目洞察数据采集器
// @namespace    http://tampermonkey.net/
// @version      7.0.3
// @description  主动请求类目洞察四类数据；四级目录遍历、15–45秒节点间隔、分批ZIP、断点续采与详细日志。
// @homepageURL  https://tools.aioz.cc/tampermonkey-scripts/
// @updateURL    https://tools.aioz.cc/tampermonkey-scripts/amazon-category-insights-json-capture/amazon-category-insights-json-capture.user.js
// @downloadURL  https://tools.aioz.cc/tampermonkey-scripts/amazon-category-insights-json-capture/amazon-category-insights-json-capture.user.js
// @match        https://sellercentral.amazon.com/selection/category-insights*
// @match        https://sellercentral.amazon.com/next/*
// @run-at       document-start
// @sandbox      raw
// @noframes
// @grant        none
// ==/UserScript==
"use strict";
(() => {

  var VERSION = "7.0.3";
  var FILTER_API = "/next/v2/getFilters";
  var KINDS = ["getPerformanceDashboard", "getFeaturesDashboard", "relatedAsin_top_grossing", "relatedAsin_new_successful"];
  var LABELS = { getPerformanceDashboard: "\u6240\u6709ASIN", getFeaturesDashboard: "\u4EA7\u54C1\u7279\u5F81\u8D8B\u52BF", relatedAsin_top_grossing: "\u6700\u7545\u9500ASIN", relatedAsin_new_successful: "\u65B0\u53D1\u5E03ASIN" };
  var LEVELS = ["keyword", "ptype", "category", "store"];
  var FILTER_NAMES = { store: "sgar-tmp-filter", category: "sgar-cat-filter", ptype: "sgar-pdt-filter", keyword: "sgar-bn-filter" };
  var DEFAULTS = { target: 50, totalLimit: 0, delayMin: 15, delayMax: 45, levels: { keyword: true, ptype: false, category: false, store: false } };
  var iso = () => (/* @__PURE__ */ new Date()).toISOString();
  var stamp = () => iso().replace(/[:.]/g, "-");
  var pathOf = (c) => [c.store.value, c.category.value, c.product_type.value, c.keyword.value];
  var pathKey = (c) => JSON.stringify(pathOf(c));
  var contextLabel = (c) => [c.store.label, c.category.label, c.product_type.label, c.keyword.label].join(" / ");
  var isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  function identifier(value) {
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
    throw new Error("\u4EE3\u7801\u4E3A\u7A7A\u6216\u6570\u5B57\u7CBE\u5EA6\u4E0D\u5B89\u5168");
  }
  function normalizeConfig(value) {
    const c = structuredClone(value);
    c.target = Number.isSafeInteger(c.target) && c.target > 0 ? c.target : 50;
    c.totalLimit = Number.isSafeInteger(c.totalLimit) && c.totalLimit >= 0 ? c.totalLimit : 0;
    c.delayMin = Number.isFinite(c.delayMin) ? Math.max(15, c.delayMin) : 15;
    c.delayMax = Number.isFinite(c.delayMax) ? Math.max(c.delayMin, 15, c.delayMax) : Math.max(c.delayMin, 45);
    c.levels = { ...DEFAULTS.levels, ...c.levels, keyword: true };
    if (c.levels.store) c.levels.category = true;
    if (c.levels.category) c.levels.ptype = true;
    return c;
  }
  var eq = (key, value) => ({ key, value, conditionalOperator: "EQUALS" });
  function dataRequest(kind, c) {
    const [market, cat, ptd, bn] = pathOf(c).map(identifier);
    if (kind.startsWith("relatedAsin_")) return {
      url: "/next/v2/relatedAsinDashboard",
      body: { insightType: "MP_CAT_PTD_BN_SEC_INSIGHT", targetMarketplaceId: market, sourceMarketplaceId: market, sectionId: kind.slice("relatedAsin_".length), filter: { logicalOperator: "AND", filters: [eq("bnId", bn), eq("ptdId", ptd), eq("catId", cat)] } }
    };
    const feature = kind === "getFeaturesDashboard";
    return { url: `/next/v2/${kind}`, body: { program: "sg_np_ar", targetMarketplaceId: market, producerId: "NEXT_SG_NP_AR_MODEL", ...feature ? { pageSize: 1e3 } : {}, filter: { logicalOperator: "AND", filters: [eq("type", feature ? "MP_CAT_PTD_BN_FEA" : "MP_CAT_PTD_BN"), eq("catId", cat), eq("ptdId", ptd), eq("bnId", bn)] } } };
  }
  function classify(kind, value, c) {
    if (!isObject(value)) throw new Error("\u54CD\u5E94\u4E0D\u662F JSON \u5BF9\u8C61");
    const explicit = { bnId: c.keyword.value, nodeId: c.keyword.value, browseNodeId: c.keyword.value, targetMarketplaceId: c.store.value, marketplaceId: c.store.value, catId: c.category.value, ptdId: c.product_type.value };
    for (const [key, expected] of Object.entries(explicit)) if (value[key] != null && identifier(value[key]) !== expected) throw new Error(`\u54CD\u5E94\u5F52\u5C5E\u51B2\u7A81\uFF1A${key}`);
    if (kind.startsWith("relatedAsin_") && value.sectionId != null && value.sectionId !== kind.slice("relatedAsin_".length)) throw new Error("\u54CD\u5E94 sectionId \u51B2\u7A81");
    function checkMetric(v, depth = 0) {
      if (!isObject(v) || depth > 5) return;
      if (typeof v.id === "string") {
        for (const category of [c.category.value, c.category.label]) {
          const prefix = `${category}_${c.product_type.value}_`;
          if (v.id.startsWith(prefix)) {
            const node = /^(\d+)_/.exec(v.id.slice(prefix.length))?.[1];
            if (node && node !== c.keyword.value) throw new Error("\u6307\u6807\u8282\u70B9\u51B2\u7A81");
          }
        }
        const variant = /^(top_grossing|new_successful)_/.exec(v.id)?.[1];
        if (variant && kind.startsWith("relatedAsin_") && variant !== kind.slice("relatedAsin_".length)) throw new Error("\u6307\u6807 ASIN \u7C7B\u578B\u51B2\u7A81");
      }
      for (const [k, x2] of Object.entries(v)) if (k !== "graphDataPointsList") checkMetric(x2, depth + 1);
    }
    checkMetric(value.demand);
    checkMetric(value.competition);
    const populated = (v) => Array.isArray(v) ? v.length > 0 : isObject(v) ? Object.keys(v).length > 0 : v !== null && v !== void 0;
    if (kind === "getFeaturesDashboard") {
      if (value.featuresName === null && value.featuresList === null) return "empty";
      if (!Array.isArray(value.featuresList)) throw new Error("featuresList \u7ED3\u6784\u672A\u77E5");
      return value.featuresList.length ? "data" : "empty";
    }
    if (kind.startsWith("relatedAsin_")) {
      if (!Array.isArray(value.relatedASINs)) throw new Error("relatedASINs \u7ED3\u6784\u672A\u77E5");
      if (value.relatedASINs.length || ["demand", "competition", "aggregatedNetShippedGMS", "aggregatedUnitsSold", "additionalMetrics"].some((k) => populated(value[k]))) return "data";
      if (!["demand", "competition", "aggregatedNetShippedGMS", "aggregatedUnitsSold", "additionalMetrics"].every((k) => k in value)) throw new Error("\u7A7A ASIN \u54CD\u5E94\u7F3A\u5C11\u660E\u786E\u7684\u65E0\u6570\u636E\u5B57\u6BB5");
      return "empty";
    }
    if (!("demand" in value) || !("competition" in value)) throw new Error("\u8868\u73B0\u54CD\u5E94\u7ED3\u6784\u672A\u77E5");
    return populated(value.demand) || populated(value.competition) ? "data" : "empty";
  }

  var DIRECTORY_TYPES = ["MP", "MP_CAT", "MP_CAT_PTD", "MP_CAT_PTD_BN"];
  var directoryKey = (type, market = "", cat = "", ptd = "") => JSON.stringify([type, market, cat, ptd]);
  function directoryPayload(type, market, cat, ptd) {
    const filters = [{ key: "type", value: type, conditionalOperator: "EQUALS" }];
    if (cat !== void 0) filters.push({ key: "catId", value: cat, conditionalOperator: "EQUALS" });
    if (ptd !== void 0) filters.push({ key: "ptdId", value: ptd, conditionalOperator: "EQUALS" });
    return { program: "sg_np_ar", producerId: "NEXT_SG_NP_AR_MODEL", pageSize: "1000", sortCriteria: [{ key: "properties.op_sc_de_co", order: "DESC" }], type, ...market !== void 0 ? { targetMarketplaceId: market } : {}, filter: { logicalOperator: "AND", filters } };
  }
  function options(json, type) {
    if (!isObject(json) || json.type !== type || !Array.isArray(json.filterDataPoints)) throw new Error(`\u76EE\u5F55\u7ED3\u6784\u65E0\u6548\uFF1A${type}`);
    const list = json.filterDataPoints;
    if (json.hasMore === true || json.nextToken || json.nextPageToken || Number(json.totalCount) > list.length) throw new Error("\u76EE\u5F55\u660E\u786E\u5B58\u5728\u672A\u5904\u7406\u5206\u9875\uFF0C\u505C\u6B62\u4EE5\u907F\u514D\u6F0F\u91C7");
    if (list.length > 1e5) throw new Error("\u76EE\u5F55\u8D85\u51FA\u4FDD\u62A4\u9608\u503C");
    const seen = /* @__PURE__ */ new Set();
    return list.map((x2, i2) => {
      if (!isObject(x2) || typeof x2.label !== "string") throw new Error("\u76EE\u5F55 label \u65E0\u6548");
      const value = identifier(x2.value);
      if (seen.has(value)) throw new Error("\u76EE\u5F55\u5B58\u5728\u91CD\u590D\u4EE3\u7801");
      seen.add(value);
      return { value, label: x2.label.replace(/\s+/g, " ").trim(), index: i2 + 1, total: list.length };
    });
  }
  var DirectoryCache = class {
    constructor(log2, changed = () => {
    }) {
      this.log = log2;
      this.changed = changed;
    }
    log;
    changed;
    entries = /* @__PURE__ */ new Map();
    seq = 0;
    put(type, market, cat, ptd, json, seq = ++this.seq) {
      const key = directoryKey(type, market, cat, ptd);
      const items = options(json, type);
      if ((this.entries.get(key)?.seq || 0) > seq) return;
      this.entries.delete(key);
      this.entries.set(key, { items, at: Date.now(), seq });
      if (this.entries.size > 64) this.entries.delete(this.entries.keys().next().value);
      this.log("I", `\u76EE\u5F55\u5C31\u7EEA ${key}\uFF5C${items.length}\u9879`);
      this.changed();
    }
    get(type, market = "", cat = "", ptd = "") {
      const entry = this.entries.get(directoryKey(type, market, cat, ptd));
      return entry && Date.now() - entry.at <= 3e5 ? structuredClone(entry.items) : void 0;
    }
    observe(body, json, seq) {
      let payload = body;
      if (typeof body === "string") {
        try {
          payload = JSON.parse(body);
        } catch {
          return;
        }
      }
      if (!isObject(payload) || !DIRECTORY_TYPES.includes(payload.type)) return;
      const type = payload.type;
      const filter = isObject(payload.filter) && Array.isArray(payload.filter.filters) ? payload.filter.filters : [];
      const field = (key) => {
        const matches = filter.filter((x2) => isObject(x2) && x2.key === key);
        if (matches.length > 1) throw new Error("\u76EE\u5F55\u8BF7\u6C42\u7236\u7EA7\u91CD\u590D");
        const v = matches[0]?.value;
        return v == null ? "" : identifier(v);
      };
      const market = payload.targetMarketplaceId == null ? "" : identifier(payload.targetMarketplaceId), cat = field("catId"), ptd = field("ptdId");
      if (type !== "MP" && !market || ["MP_CAT_PTD", "MP_CAT_PTD_BN"].includes(type) && !cat || type === "MP_CAT_PTD_BN" && !ptd) throw new Error("\u76EE\u5F55\u8BF7\u6C42\u7F3A\u5C11\u7236\u7EA7\u4EE3\u7801");
      this.put(type, market, cat, ptd, json, seq);
    }
  };
  function installFilterHooks(cache2, log2) {
    const original = window.fetch;
    const nativeFetch2 = (input, init) => original.call(window, input, init);
    const target = (input) => {
      try {
        const u = new URL(String(input), location.href);
        return u.origin === location.origin && u.pathname === FILTER_API;
      } catch {
        return false;
      }
    };
    const observe = (body, raw, status, seq) => {
      if (status < 200 || status >= 300) return;
      try {
        cache2.observe(body, typeof raw === "string" ? JSON.parse(raw) : raw, seq);
      } catch (e) {
        log2("W", `\u76EE\u5F55\u76D1\u542C\u672A\u91C7\u7528\uFF1A${String(e)}`);
      }
    };
    window.fetch = function(input, init) {
      const url = typeof input === "string" || input instanceof URL ? input : input.url;
      if (!target(url)) return original.apply(this, [input, init]);
      const seq = ++cache2.seq;
      let body;
      try {
        const b = init && Object.hasOwn(init, "body") ? init.body : input instanceof Request ? input.clone().text() : null;
        body = Promise.resolve(b instanceof Blob ? b.text() : b instanceof URLSearchParams ? Object.fromEntries(b) : b);
      } catch {
        body = Promise.resolve(null);
      }
      body = body.catch(() => null);
      const result = original.apply(this, [input, init]);
      void result.then((r) => Promise.all([body, r.clone().text()]).then(([b, raw]) => observe(b, raw, r.status, seq))).catch((e) => log2("W", `fetch \u76EE\u5F55\u76D1\u542C\u5F02\u5E38\uFF1A${String(e)}`));
      return result;
    };
    const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
    const meta = /* @__PURE__ */ new WeakMap();
    XMLHttpRequest.prototype.open = function(method, url, async = true, username, password) {
      meta.set(this, String(url));
      return open.call(this, method, url, async, username, password);
    };
    XMLHttpRequest.prototype.send = function(body) {
      if (target(meta.get(this) || "")) {
        const seq = ++cache2.seq;
        this.addEventListener("load", () => {
          try {
            observe(body, this.responseType === "json" ? this.response : this.responseText, this.status, seq);
          } catch (e) {
            log2("W", `XHR \u76EE\u5F55\u76D1\u542C\u5F02\u5E38\uFF1A${String(e)}`);
          }
        }, { once: true });
      }
      return send.call(this, body);
    };
    log2("I", "document-start\uFF1A\u56DB\u7EA7 getFilters \u76D1\u542C\u5DF2\u5B89\u88C5\uFF1B\u7B49\u5F85\u624B\u52A8\u5F00\u59CB\u4E1A\u52A1\u91C7\u96C6");
    return nativeFetch2;
  }
  var remaining = (items, start2, first, label) => {
    if (!first) return items;
    const index = items.findIndex((x2) => x2.value === start2);
    if (index < 0) throw new Error(`\u8D77\u70B9\u5DF2\u4E0D\u5728\u6709\u6548${label}\u76EE\u5F55\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9`);
    return items.slice(index);
  };
  async function* traverse(start2, levels, get) {
    const stores = levels.store ? remaining(await get("MP"), start2.store.value, true, "\u5546\u57CE") : [start2.store];
    for (let si = 0; si < stores.length; si++) {
      const store = stores[si];
      const categories = levels.category ? remaining(await get("MP_CAT", store.value), start2.category.value, si === 0, "\u7C7B\u522B") : [start2.category];
      for (let ci = 0; ci < categories.length; ci++) {
        const category = categories[ci], firstCategory = si === 0 && ci === 0;
        const types = levels.ptype ? remaining(await get("MP_CAT_PTD", store.value, category.value), start2.product_type.value, firstCategory, "\u5546\u54C1\u7C7B\u578B") : [start2.product_type];
        for (let pi = 0; pi < types.length; pi++) {
          const product_type = types[pi];
          const keywords = remaining(await get("MP_CAT_PTD_BN", store.value, category.value, product_type.value), start2.keyword.value, firstCategory && pi === 0, "\u5173\u952E\u8BCD");
          for (const keyword of keywords) yield { store, category, product_type, keyword, nodeId: keyword.value };
        }
      }
    }
  }

  var DB_NAME = "amz_category_insights_capture_v1";
  var BrowserStore = class {
    db;
    constructor() {
      this.db = new Promise((resolve, reject) => {
        const r = indexedDB.open(DB_NAME, 2);
        r.onupgradeneeded = () => {
          for (const [name, keyPath] of [["batches", "key"], ["quarantine", "id"], ["tasks", "key"]]) if (!r.result.objectStoreNames.contains(name)) r.result.createObjectStore(name, { keyPath });
        };
        r.onsuccess = () => {
          r.result.onversionchange = () => r.result.close();
          resolve(r.result);
        };
        r.onerror = () => reject(r.error);
        r.onblocked = () => reject(new Error("\u6570\u636E\u5E93\u5347\u7EA7\u88AB\u5176\u4ED6\u9875\u9762\u963B\u585E\uFF0C\u8BF7\u5173\u95ED\u65E7\u7248\u91C7\u96C6\u9875\u9762"));
      });
    }
    async get(table, key) {
      const db = await this.db;
      return new Promise((resolve, reject) => {
        const r = db.transaction(table).objectStore(table).get(key);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    }
    async all(table) {
      const db = await this.db;
      return new Promise((resolve, reject) => {
        const values = [], tx = db.transaction(table), r = tx.objectStore(table).openCursor();
        r.onsuccess = () => {
          const cursor = r.result;
          if (!cursor) return;
          const value = cursor.value;
          if (table === "batches") {
            for (const f of Object.values(value.files || {})) if (f.exported) delete f.text;
          }
          values.push(value);
          cursor.continue();
        };
        tx.oncomplete = () => resolve(values);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    }
    async write(ops) {
      if (!ops.length) return;
      const db = await this.db;
      return new Promise((resolve, reject) => {
        const tx = db.transaction([...new Set(ops.map((x2) => x2.table))], "readwrite");
        for (const op of ops) {
          const store = tx.objectStore(op.table);
          if ("clear" in op) store.clear();
          else if ("delete" in op) store.delete(op.key);
          else store.put(structuredClone(op.value));
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("\u4FDD\u5B58\u4E8B\u52A1\u4E2D\u65AD"));
      });
    }
  };

  var Stopped = class extends Error {
  };
  var RateLimited = class extends Error {
  };
  var AuthError = class extends Error {
  };
  function wait(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Stopped("\u5DF2\u7EC8\u6B62"));
        return;
      }
      const abort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(new Stopped("\u5DF2\u7EC8\u6B62"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, ms);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  function retryAfter(value, now = Date.now()) {
    if (!value) return 0;
    const numeric = Number(value), result = Number.isFinite(numeric) ? numeric * 1e3 : Date.parse(value) - now;
    return Number.isFinite(result) ? Math.max(0, result) : 0;
  }
  var Collector = class {
    constructor(store, cache2, fetcher, log2, changed = () => {
    }, runtime = {}) {
      this.store = store;
      this.cache = cache2;
      this.fetcher = fetcher;
      this.log = log2;
      this.changed = changed;
      this.rt = { now: Date.now, random: Math.random, wait, timeout: 6e4, retries: 3, ...runtime };
    }
    store;
    cache;
    fetcher;
    log;
    changed;
    batches = /* @__PURE__ */ new Map();
    deleted = /* @__PURE__ */ new Set();
    task = null;
    running = false;
    fatal = null;
    controller = new AbortController();
    requests = 0;
    queue = Promise.resolve();
    exporter = async () => false;
    rt;
    serial(work) {
      const next = this.queue.then(work);
      this.queue = next.catch(() => {
      });
      return next;
    }
    async write(ops) {
      try {
        await this.store.write(ops);
      } catch (e) {
        this.fatal = String(e);
        if (this.task) {
          this.task.status = "storage-error";
          this.task.reason = this.fatal;
        }
        this.controller.abort();
        this.log("E", `\u4FDD\u5B58\u5931\u8D25\uFF0C\u5DF2\u505C\u6B62\u65B0\u8BF7\u6C42\uFF1B\u8BF7\u5148\u4E0B\u8F7D\u5185\u5B58\u6570\u636E\u518D\u5237\u65B0\uFF1A${String(e)}`);
        this.changed();
        throw e;
      }
    }
    async restore() {
      this.task = await this.store.get("tasks", "active") || null;
      const cleanup = [{ table: "quarantine", clear: true }];
      for (const b of await this.store.all("batches")) {
        if (!b.path) b.path = pathOf(b.ctx);
        const state = this.task?.nodes[pathKey(b.ctx)];
        const archived = (Object.values(b.files).length > 0 || !!b.exportId) && Object.values(b.files).every((f) => f.exported);
        if (archived || state?.batchKey === b.key && state.deleted) {
          cleanup.push({ table: "batches", key: b.key, delete: true });
          continue;
        }
        let changed = false;
        for (const kind of KINDS) if (b.files[kind]?.exported) {
          delete b.files[kind];
          if (b.outcomes) delete b.outcomes[kind];
          changed = true;
        }
        if (b.exportId || b.supplementOf) {
          delete b.exportId;
          delete b.supplementOf;
          changed = true;
        }
        if (!b.outcomes) {
          b.outcomes = {};
          for (const k of KINDS) if (b.files[k]) b.outcomes[k] = { status: "data", attempts: 0, reason: "\u65E7\u7248\u8BB0\u5F55\uFF0C\u4FDD\u7559\u539F\u59CB\u6570\u636E" };
        }
        for (const o of Object.values(b.outcomes)) if (o.status === "pending") {
          o.status = "interrupted";
          o.reason = "\u9875\u9762\u5237\u65B0\u524D\u8BF7\u6C42\u672A\u5B8C\u6210";
        }
        this.batches.set(b.key, b);
        if (changed) cleanup.push({ table: "batches", value: b });
      }
      if (this.task) {
        for (const [path, node] of Object.entries(this.task.nodes)) if (!this.batches.has(node.batchKey)) delete this.task.nodes[path];
        cleanup.push({ table: "tasks", value: structuredClone(this.task) });
      }
      await this.write(cleanup);
      if (this.task?.status === "running") {
        this.task.status = "stopped";
        this.task.reason = "\u9875\u9762\u5DF2\u5237\u65B0\uFF0C\u53EF\u7EE7\u7EED\u672A\u5B8C\u6210\u4EFB\u52A1";
      }
      this.changed();
    }
    async hydrated(b) {
      const copy = structuredClone(b);
      if (Object.values(copy.files).some((f) => f.text === void 0)) {
        const old = await this.store.get("batches", b.key);
        for (const k of KINDS) {
          const f = copy.files[k], previous = old?.files[k];
          if (f && f.text === void 0 && previous?.requestId === f.requestId) f.text = previous.text;
        }
      }
      return copy;
    }
    async persist(b) {
      const ops = [];
      if (b && !this.deleted.has(b.key)) ops.push({ table: "batches", value: await this.hydrated(b) });
      if (this.task) ops.push({ table: "tasks", value: structuredClone(this.task) });
      await this.write(ops);
    }
    async http(url, body) {
      if (this.controller.signal.aborted) throw new Stopped("\u5DF2\u7EC8\u6B62");
      const requestId = `${this.task?.id || "directory"}-${++this.requests}`;
      const abort = new AbortController();
      const stop = () => abort.abort();
      this.controller.signal.addEventListener("abort", stop, { once: true });
      const timeout = setTimeout(() => abort.abort(), this.rt.timeout), started = this.rt.now();
      this.log("I", `\u8BF7\u6C42 ${requestId}\uFF5C${url}\uFF5C${this.task?.current ? contextLabel(this.task.current) : "\u83B7\u53D6\u76EE\u5F55"}`);
      try {
        const r = await this.fetcher(url, { method: "POST", credentials: "include", signal: abort.signal, headers: { accept: "application/json, text/plain, */*", "content-type": "application/json;charset=UTF-8" }, body: JSON.stringify(body) });
        const raw = await r.text();
        let json;
        try {
          json = raw ? JSON.parse(raw) : void 0;
        } catch {
        }
        this.log("I", `\u54CD\u5E94 ${requestId}\uFF5CHTTP ${r.status}\uFF5C${this.rt.now() - started}ms`);
        return { status: r.status, raw, json, retry: r.status === 429 || [500, 502, 503, 504].includes(r.status), retryAfter: retryAfter(r.headers.get("Retry-After"), this.rt.now()), requestId };
      } catch (e) {
        return { status: 0, raw: "", error: String(e), retry: !this.controller.signal.aborted, aborted: this.controller.signal.aborted, retryAfter: 0, requestId };
      } finally {
        clearTimeout(timeout);
        this.controller.signal.removeEventListener("abort", stop);
      }
    }
    async cool(milliseconds) {
      if (!this.task) return;
      this.task.cooldownUntil = this.rt.now() + milliseconds;
      await this.serial(() => this.persist());
      this.log("W", `\u7EDF\u4E00\u9650\u6D41\u51B7\u5374 ${Math.ceil(milliseconds / 1e3)}\u79D2\uFF0C\u671F\u95F4\u4E0D\u542F\u52A8\u8BF7\u6C42`);
      await this.rt.wait(milliseconds, this.controller.signal);
    }
    async directory(type, market = "", cat = "", ptd = "") {
      if (this.controller.signal.aborted) throw new Stopped("\u5DF2\u7EC8\u6B62");
      const cached = this.cache.get(type, market, cat, ptd);
      if (cached) {
        this.log("I", `\u590D\u7528\u76EE\u5F55 ${JSON.stringify([type, market, cat, ptd])}\uFF5C${cached.length}\u9879`);
        return cached;
      }
      let rate = false;
      for (let attempt = 0; attempt <= this.rt.retries; attempt++) {
        const seq = ++this.cache.seq;
        const r = await this.http("/next/v2/getFilters", directoryPayload(type, market || void 0, cat || void 0, ptd || void 0));
        if (r.aborted) throw new Stopped("\u5DF2\u7EC8\u6B62");
        if ([401, 403].includes(r.status)) throw new AuthError(`\u76EE\u5F55 HTTP ${r.status}`);
        if (r.status === 429) {
          if (rate) throw new RateLimited("\u51B7\u5374\u540E\u7684\u76EE\u5F55\u8BF7\u6C42\u4ECD\u8FD4\u56DE429");
          rate = true;
          await this.cool(Math.max(6e4, r.retryAfter) + this.rt.random() * 5e3);
        } else if (r.status >= 200 && r.status < 300) {
          const items = options(r.json, type);
          this.cache.put(type, market, cat, ptd, r.json, seq);
          return items;
        } else if (!r.retry || attempt === this.rt.retries) throw new Error(`\u76EE\u5F55\u8BF7\u6C42\u5931\u8D25\uFF1A${type}\uFF5CHTTP ${r.status}\uFF5C${r.error || ""}`);
        else await this.rt.wait(Math.max(3e3 * 2 ** attempt, r.retryAfter), this.controller.signal);
      }
      throw new Error("\u76EE\u5F55\u91CD\u8BD5\u8017\u5C3D");
    }
    async resolveStart(start2) {
      const find = (items, value, label) => {
        const x2 = items.find((c) => c.value === value);
        if (!x2) throw new Error(`\u8D77\u70B9\u5DF2\u4E0D\u5728\u6709\u6548${label}\u76EE\u5F55\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9`);
        return x2;
      };
      const store = find(await this.directory("MP"), start2.store.value, "\u5546\u57CE");
      const category = find(await this.directory("MP_CAT", store.value), start2.category.value, "\u7C7B\u522B");
      const product_type = find(await this.directory("MP_CAT_PTD", store.value, category.value), start2.product_type.value, "\u5546\u54C1\u7C7B\u578B");
      const keyword = find(await this.directory("MP_CAT_PTD_BN", store.value, category.value, product_type.value), start2.keyword.value, "\u5173\u952E\u8BCD");
      return { store, category, product_type, keyword, nodeId: keyword.value };
    }
    async result(b, kind, r) {
      await this.serial(async () => {
        if (this.deleted.has(b.key)) return;
        const task = this.task;
        const previous = b.outcomes?.[kind];
        const outcome = { status: r.aborted ? "interrupted" : "failed", http: r.status, attempts: previous?.attempts || 1, at: iso() };
        let reason = r.error || (r.status < 200 || r.status >= 300 ? `HTTP ${r.status}` : "");
        if (!reason) {
          if (r.status === 204) {
            outcome.status = "no-content";
            outcome.reason = "HTTP 204\uFF0C\u65E0\u54CD\u5E94\u6B63\u6587";
          } else {
            try {
              outcome.status = classify(kind, r.json, b.ctx);
            } catch (e) {
              reason = String(e);
            }
            if (!reason) {
              b.files[kind] = { name: `${b.nodeId}\u4E28${kind}\u4E28${stamp()}.json`, text: r.raw, exported: false, requestId: r.requestId, seq: this.requests };
            }
          }
        }
        const ops = [];
        if (reason) {
          outcome.reason = reason;
        }
        b.outcomes ||= {};
        b.outcomes[kind] = outcome;
        b.updatedAt = this.rt.now();
        const node = task.nodes[pathKey(b.ctx)];
        if (!node.counted && Object.keys(b.files).length) {
          node.counted = true;
          task.count++;
        }
        ops.push({ table: "batches", value: await this.hydrated(b) }, { table: "tasks", value: structuredClone(task) });
        await this.write(ops);
        this.log(outcome.status === "failed" ? "W" : "I", `${b.nodeId}\uFF5C${kind}\uFF5C${outcome.status}${reason ? `\uFF5C${reason}` : ""}`);
        this.changed();
      });
    }
    async collect(c) {
      const task = this.task, pk = pathKey(c);
      let state = task.nodes[pk];
      if (state?.deleted || state?.processed) return;
      let b = state ? this.batches.get(state.batchKey) : void 0;
      if (!b) {
        const key = JSON.stringify([task.id, ...pathOf(c)]);
        b = { key, taskId: task.id, path: pathOf(c), nodeId: c.keyword.value, ctx: structuredClone(c), round: task.id, createdAt: this.rt.now(), updatedAt: this.rt.now(), files: {}, outcomes: {}, checked: false, pageUrl: "https://sellercentral.amazon.com/selection/category-insights" };
        state = { batchKey: key, processed: false, counted: false, deleted: false };
        task.nodes[pk] = state;
        this.batches.set(key, b);
      }
      this.changed();
      let pending = KINDS.filter((k) => !["data", "empty", "no-content"].includes(b.outcomes?.[k]?.status || ""));
      let rateSeen = false;
      for (let wave = 0; pending.length && wave <= this.rt.retries; wave++) {
        if (this.controller.signal.aborted) throw new Stopped("\u5DF2\u7EC8\u6B62");
        if (this.deleted.has(b.key)) return;
        const batch = b;
        await this.serial(async () => {
          for (const k of pending) {
            batch.outcomes ||= {};
            batch.outcomes[k] = { status: "pending", attempts: (batch.outcomes[k]?.attempts || 0) + 1 };
          }
          await this.persist(batch);
        });
        const settled = await Promise.all(pending.map(async (kind) => {
          const req = dataRequest(kind, c), r = await this.http(req.url, req.body);
          await this.result(batch, kind, r);
          return { kind, r };
        }));
        if (this.deleted.has(batch.key)) return;
        if (this.controller.signal.aborted) throw new Stopped("\u5DF2\u7EC8\u6B62");
        if (settled.some((x2) => [401, 403].includes(x2.r.status))) throw new AuthError("HTTP 401/403\uFF0C\u505C\u6B62\u540E\u7EED\u8C03\u5EA6");
        const rates = settled.filter((x2) => x2.r.status === 429);
        if (rates.length) {
          if (rateSeen) throw new RateLimited("\u51B7\u5374\u540E\u7684\u91CD\u8BD5\u6CE2\u6B21\u518D\u6B21\u51FA\u73B0429");
          rateSeen = true;
          await this.cool(Math.max(6e4, ...rates.map((x2) => x2.r.retryAfter)) + this.rt.random() * 5e3);
        }
        pending = settled.filter((x2) => x2.r.retry && wave < this.rt.retries && !this.deleted.has(batch.key)).map((x2) => x2.kind);
        if (pending.length && !rates.length) {
          const delay = Math.max(3e3 * 2 ** wave, ...settled.filter((x2) => pending.includes(x2.kind)).map((x2) => x2.r.retryAfter));
          this.log("W", `\u4EC5\u91CD\u8BD5\u5931\u8D25\u63A5\u53E3 ${pending.join(",")}\uFF5C\u7B49\u5F85${Math.ceil(delay / 1e3)}\u79D2`);
          await this.rt.wait(delay, this.controller.signal);
        }
      }
      await this.serial(async () => {
        if (!state.deleted) state.processed = true;
        await this.persist(this.deleted.has(b.key) ? void 0 : b);
      });
    }
    stop() {
      if (!this.running) return;
      this.log("W", "\u6536\u5230\u7EC8\u6B62\u6307\u4EE4\uFF1A\u53D6\u6D88\u7B49\u5F85\u548C\u5728\u9014\u8BF7\u6C42\uFF0C\u4FDD\u5B58\u5DF2\u6536\u5230\u7684\u6570\u636E\u5E76\u6536\u5C3E");
      this.controller.abort();
    }
    async run(start2, config2 = DEFAULTS, resume = false) {
      if (this.running) throw new Error("\u5DF2\u6709\u4EFB\u52A1\u6B63\u5728\u8FD0\u884C");
      if (this.fatal) throw new Error("\u5B58\u50A8\u6545\u969C\u5C1A\u672A\u6062\u590D\uFF0C\u8BF7\u5148\u4E0B\u8F7D\u5185\u5B58\u6570\u636E");
      this.running = true;
      this.controller = new AbortController();
      try {
        if (resume) {
          if (!this.task) throw new Error("\u6CA1\u6709\u53EF\u7EE7\u7EED\u7684\u4EFB\u52A1");
          for (const node of Object.values(this.task.nodes)) if (!node.deleted) {
            const batch = this.batches.get(node.batchKey);
            node.processed = !!batch && KINDS.every((k) => ["data", "empty", "no-content"].includes(batch.outcomes?.[k]?.status || ""));
          }
          this.task.status = "running";
          this.task.reason = "";
        } else {
          this.task = { key: "active", id: `task-${this.rt.now()}-${Math.random().toString(36).slice(2)}`, config: normalizeConfig(config2), start: structuredClone(start2), current: null, status: "running", nodes: {}, cursor: 0, count: 0, reason: "", cooldownUntil: 0, createdAt: this.rt.now() };
        }
        this.log("I", `===== \u4EFB\u52A1${resume ? "\u7EED\u91C7" : "\u5F00\u59CB"}\uFF5C${contextLabel(this.task.start)}\uFF5C\u6BCF\u6279${this.task.config.target}\u8282\u70B9\uFF5C\u603B\u91CF${this.task.config.totalLimit || "\u4E0D\u9650"}\uFF5C\u95F4\u9694${this.task.config.delayMin}\u2013${this.task.config.delayMax}\u79D2\uFF5C\u5FAA\u73AF${Object.entries(this.task.config.levels).filter(([, v]) => v).map(([k]) => k).join("\u2192")} =====`);
        this.changed();
        await this.serial(() => this.persist());
        if (this.task.cooldownUntil > this.rt.now()) await this.rt.wait(this.task.cooldownUntil - this.rt.now(), this.controller.signal);
        this.task.start = await this.resolveStart(this.task.start);
        const iterator = traverse(this.task.start, this.task.config.levels, (...args) => this.directory(...args));
        let previous = false, position = 0;
        while (!this.controller.signal.aborted) {
          const atLimit = this.task.config.totalLimit && this.task.count >= this.task.config.totalLimit;
          if (atLimit && !Object.values(this.task.nodes).some((n) => n.counted && !n.processed && !n.deleted)) {
            this.log("I", "\u8FBE\u5230\u672C\u4EFB\u52A1\u8282\u70B9\u603B\u91CF\u4E0A\u9650\uFF0C\u505C\u6B62\u542F\u52A8\u65B0\u8282\u70B9");
            break;
          }
          const next = await iterator.next();
          if (next.done) break;
          const ordinal = position++;
          const state = this.task.nodes[pathKey(next.value)];
          if (ordinal < (this.task.cursor || 0) && !state) continue;
          if (state?.processed || state?.deleted || atLimit && !state?.counted) continue;
          if (previous) {
            const { delayMin, delayMax } = this.task.config, ms = (delayMin + this.rt.random() * (delayMax - delayMin)) * 1e3;
            this.log("I", `\u8282\u70B9\u95F4\u968F\u673A\u5EF6\u8FDF ${(ms / 1e3).toFixed(1)}\u79D2`);
            await this.rt.wait(ms, this.controller.signal);
          }
          this.task.current = next.value;
          this.log("I", `\u5F00\u59CB\u8282\u70B9\uFF5C${contextLabel(next.value)}`);
          this.changed();
          await this.collect(next.value);
          previous = true;
          this.task.cursor = Math.max(this.task.cursor || 0, ordinal + 1);
          await this.serial(() => this.persist());
          const pending = this.pendingKeys().filter((key) => this.batches.get(key)?.taskId === this.task.id);
          if (pending.length >= this.task.config.target && !await this.exporter(pending, "\u6279\u91CF")) throw new Error("\u6279\u91CF\u4E0B\u8F7D\u5931\u8D25\uFF0C\u505C\u6B62\u5E76\u4FDD\u7559\u5F85\u4E0B\u8F7D\u6570\u636E");
        }
        if (this.controller.signal.aborted) throw new Stopped("\u624B\u52A8\u7EC8\u6B62");
        this.task.status = "completed";
        this.task.reason = "\u904D\u5386\u5B8C\u6210\u6216\u8FBE\u5230\u6570\u91CF\u4E0A\u9650";
      } catch (e) {
        if (this.task) {
          this.task.status = this.fatal ? "storage-error" : e instanceof RateLimited ? "rate-limited" : e instanceof AuthError ? "auth-error" : e instanceof Stopped ? "stopped" : "failed";
          this.task.reason = String(e);
        }
        this.log("W", `\u4EFB\u52A1\u7ED3\u675F\uFF1A${String(e)}`);
      } finally {
        if (!this.fatal) {
          try {
            await this.serial(async () => {
              for (const b of this.batches.values()) if (b.taskId === this.task?.id && Object.values(b.outcomes || {}).some((o) => o.status === "pending")) {
                for (const o of Object.values(b.outcomes || {})) if (o.status === "pending") {
                  o.status = "interrupted";
                  o.reason = "\u4EFB\u52A1\u7ED3\u675F\u524D\u672A\u83B7\u5F97\u5B8C\u6574\u54CD\u5E94";
                }
                await this.persist(b);
              }
            });
          } catch {
          }
        }
        if (!this.fatal) {
          try {
            await this.serial(() => this.persist());
          } catch {
          }
        }
        const remaining2 = this.pendingKeys().filter((key) => this.batches.get(key)?.taskId === this.task?.id);
        if (remaining2.length) {
          try {
            await this.exporter(remaining2, "\u6536\u5C3E");
          } catch (e) {
            this.log("E", `\u6536\u5C3E\u4E0B\u8F7D\u5931\u8D25\uFF0C\u6570\u636E\u4FDD\u7559\uFF1A${String(e)}`);
          }
        }
        this.running = false;
        this.changed();
        this.log("I", `\u672C\u6B21\u4EFB\u52A1\u7ED3\u675F\uFF5C\u5DF2\u4FDD\u5B58${this.task?.count || 0}\u8282\u70B9\uFF5C${this.task?.status || "\u672A\u5F00\u59CB"}`);
      }
    }
    pendingKeys() {
      return [...this.batches.values()].filter((b) => Object.keys(b.files).length > 0).map((b) => b.key);
    }
    visible() {
      return [...this.batches.values()].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
    }
    async snapshots(keys) {
      return this.serial(async () => Promise.all(keys.filter((k) => !this.deleted.has(k) && this.batches.has(k)).map((k) => this.hydrated(this.batches.get(k)))));
    }
    async remove(keys, downloaded = false) {
      const selected = keys.filter((k) => this.batches.has(k));
      for (const key of selected) this.deleted.add(key);
      try {
        await this.serial(async () => {
          const task = this.task ? structuredClone(this.task) : null;
          if (task) {
            for (const [path, node] of Object.entries(task.nodes)) if (selected.includes(node.batchKey)) delete task.nodes[path];
          }
          const ops = selected.map((key) => ({ table: "batches", key, delete: true }));
          if (task) ops.push({ table: "tasks", value: task });
          await this.write(ops);
          if (this.task && task) this.task.nodes = task.nodes;
          for (const key of selected) this.batches.delete(key);
        });
      } catch (e) {
        for (const key of selected) this.deleted.delete(key);
        throw e;
      }
      this.changed();
      this.log("I", `${downloaded ? "\u4E0B\u8F7D\u5DF2\u89E6\u53D1\uFF0C\u5DF2\u6E05\u9664" : "\u5DF2\u5B8C\u5168\u5220\u9664"} ${selected.length}\u4E2A\u8282\u70B9\u7684\u5185\u5B58\u3001IndexedDB\u6B63\u6587\u548C\u7ED3\u679C\u8BB0\u5F55\uFF1B\u4EC5\u4FDD\u7559\u4EFB\u52A1\u603B\u4F53\u8FDB\u5EA6\u4E0E\u8BA1\u6570`);
    }
  };

  var u8 = Uint8Array;
  var u16 = Uint16Array;
  var i32 = Int32Array;
  var fleb = new u8([
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    1,
    1,
    1,
    2,
    2,
    2,
    2,
    3,
    3,
    3,
    3,
    4,
    4,
    4,
    4,
    5,
    5,
    5,
    5,
    0,
    /* unused */
    0,
    0,
    /* impossible */
    0
  ]);
  var fdeb = new u8([
    0,
    0,
    0,
    0,
    1,
    1,
    2,
    2,
    3,
    3,
    4,
    4,
    5,
    5,
    6,
    6,
    7,
    7,
    8,
    8,
    9,
    9,
    10,
    10,
    11,
    11,
    12,
    12,
    13,
    13,
    /* unused */
    0,
    0
  ]);
  var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
  var freb = function(eb, start2) {
    var b = new u16(31);
    for (var i2 = 0; i2 < 31; ++i2) {
      b[i2] = start2 += 1 << eb[i2 - 1];
    }
    var r = new i32(b[30]);
    for (var i2 = 1; i2 < 30; ++i2) {
      for (var j = b[i2]; j < b[i2 + 1]; ++j) {
        r[j] = j - b[i2] << 5 | i2;
      }
    }
    return { b, r };
  };
  var _a = freb(fleb, 2);
  var fl = _a.b;
  var revfl = _a.r;
  fl[28] = 258, revfl[258] = 28;
  var _b = freb(fdeb, 0);
  var fd = _b.b;
  var revfd = _b.r;
  var rev = new u16(32768);
  for (i = 0; i < 32768; ++i) {
    x = (i & 43690) >> 1 | (i & 21845) << 1;
    x = (x & 52428) >> 2 | (x & 13107) << 2;
    x = (x & 61680) >> 4 | (x & 3855) << 4;
    rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
  }
  var x;
  var i;
  var hMap = (function(cd, mb, r) {
    var s = cd.length;
    var i2 = 0;
    var l = new u16(mb);
    for (; i2 < s; ++i2) {
      if (cd[i2])
        ++l[cd[i2] - 1];
    }
    var le = new u16(mb);
    for (i2 = 1; i2 < mb; ++i2) {
      le[i2] = le[i2 - 1] + l[i2 - 1] << 1;
    }
    var co;
    if (r) {
      co = new u16(1 << mb);
      var rvb = 15 - mb;
      for (i2 = 0; i2 < s; ++i2) {
        if (cd[i2]) {
          var sv = i2 << 4 | cd[i2];
          var r_1 = mb - cd[i2];
          var v = le[cd[i2] - 1]++ << r_1;
          for (var m = v | (1 << r_1) - 1; v <= m; ++v) {
            co[rev[v] >> rvb] = sv;
          }
        }
      }
    } else {
      co = new u16(s);
      for (i2 = 0; i2 < s; ++i2) {
        if (cd[i2]) {
          co[i2] = rev[le[cd[i2] - 1]++] >> 15 - cd[i2];
        }
      }
    }
    return co;
  });
  var flt = new u8(288);
  for (i = 0; i < 144; ++i)
    flt[i] = 8;
  var i;
  for (i = 144; i < 256; ++i)
    flt[i] = 9;
  var i;
  for (i = 256; i < 280; ++i)
    flt[i] = 7;
  var i;
  for (i = 280; i < 288; ++i)
    flt[i] = 8;
  var i;
  var fdt = new u8(32);
  for (i = 0; i < 32; ++i)
    fdt[i] = 5;
  var i;
  var flm = /* @__PURE__ */ hMap(flt, 9, 0);
  var fdm = /* @__PURE__ */ hMap(fdt, 5, 0);
  var shft = function(p) {
    return (p + 7) / 8 | 0;
  };
  var slc = function(v, s, e) {
    if (s == null || s < 0)
      s = 0;
    if (e == null || e > v.length)
      e = v.length;
    return new u8(v.subarray(s, e));
  };
  var ec = [
    "unexpected EOF",
    "invalid block type",
    "invalid length/literal",
    "invalid distance",
    "stream finished",
    "no stream handler",
    ,
    // determined by compression function
    "no callback",
    "invalid UTF-8 data",
    "extra field too long",
    "date not in range 1980-2099",
    "filename too long",
    "stream finishing",
    "invalid zip data"
    // determined by unknown compression method
  ];
  var err = function(ind, msg, nt) {
    var e = new Error(msg || ec[ind]);
    e.code = ind;
    if (Error.captureStackTrace)
      Error.captureStackTrace(e, err);
    if (!nt)
      throw e;
    return e;
  };
  var wbits = function(d, p, v) {
    v <<= p & 7;
    var o = p / 8 | 0;
    d[o] |= v;
    d[o + 1] |= v >> 8;
  };
  var wbits16 = function(d, p, v) {
    v <<= p & 7;
    var o = p / 8 | 0;
    d[o] |= v;
    d[o + 1] |= v >> 8;
    d[o + 2] |= v >> 16;
  };
  var hTree = function(d, mb) {
    var t = [];
    for (var i2 = 0; i2 < d.length; ++i2) {
      if (d[i2])
        t.push({ s: i2, f: d[i2] });
    }
    var s = t.length;
    var t2 = t.slice();
    if (!s)
      return { t: et, l: 0 };
    if (s == 1) {
      var v = new u8(t[0].s + 1);
      v[t[0].s] = 1;
      return { t: v, l: 1 };
    }
    t.sort(function(a, b) {
      return a.f - b.f;
    });
    t.push({ s: -1, f: 25001 });
    var l = t[0], r = t[1], i0 = 0, i1 = 1, i22 = 2;
    t[0] = { s: -1, f: l.f + r.f, l, r };
    while (i1 != s - 1) {
      l = t[t[i0].f < t[i22].f ? i0++ : i22++];
      r = t[i0 != i1 && t[i0].f < t[i22].f ? i0++ : i22++];
      t[i1++] = { s: -1, f: l.f + r.f, l, r };
    }
    var maxSym = t2[0].s;
    for (var i2 = 1; i2 < s; ++i2) {
      if (t2[i2].s > maxSym)
        maxSym = t2[i2].s;
    }
    var tr = new u16(maxSym + 1);
    var mbt = ln(t[i1 - 1], tr, 0);
    if (mbt > mb) {
      var i2 = 0, dt = 0;
      var lft = mbt - mb, cst = 1 << lft;
      t2.sort(function(a, b) {
        return tr[b.s] - tr[a.s] || a.f - b.f;
      });
      for (; i2 < s; ++i2) {
        var i2_1 = t2[i2].s;
        if (tr[i2_1] > mb) {
          dt += cst - (1 << mbt - tr[i2_1]);
          tr[i2_1] = mb;
        } else
          break;
      }
      dt >>= lft;
      while (dt > 0) {
        var i2_2 = t2[i2].s;
        if (tr[i2_2] < mb)
          dt -= 1 << mb - tr[i2_2]++ - 1;
        else
          ++i2;
      }
      for (; i2 >= 0 && dt; --i2) {
        var i2_3 = t2[i2].s;
        if (tr[i2_3] == mb) {
          --tr[i2_3];
          ++dt;
        }
      }
      mbt = mb;
    }
    return { t: new u8(tr), l: mbt };
  };
  var ln = function(n, l, d) {
    return n.s == -1 ? Math.max(ln(n.l, l, d + 1), ln(n.r, l, d + 1)) : l[n.s] = d;
  };
  var lc = function(c) {
    var s = c.length;
    while (s && !c[--s])
      ;
    var cl = new u16(++s);
    var cli = 0, cln = c[0], cls = 1;
    var w = function(v) {
      cl[cli++] = v;
    };
    for (var i2 = 1; i2 <= s; ++i2) {
      if (c[i2] == cln && i2 != s)
        ++cls;
      else {
        if (!cln && cls > 2) {
          for (; cls > 138; cls -= 138)
            w(32754);
          if (cls > 2) {
            w(cls > 10 ? cls - 11 << 5 | 28690 : cls - 3 << 5 | 12305);
            cls = 0;
          }
        } else if (cls > 3) {
          w(cln), --cls;
          for (; cls > 6; cls -= 6)
            w(8304);
          if (cls > 2)
            w(cls - 3 << 5 | 8208), cls = 0;
        }
        while (cls--)
          w(cln);
        cls = 1;
        cln = c[i2];
      }
    }
    return { c: cl.subarray(0, cli), n: s };
  };
  var clen = function(cf, cl) {
    var l = 0;
    for (var i2 = 0; i2 < cl.length; ++i2)
      l += cf[i2] * cl[i2];
    return l;
  };
  var wfblk = function(out, pos, dat) {
    var s = dat.length;
    var o = shft(pos + 2);
    out[o] = s & 255;
    out[o + 1] = s >> 8;
    out[o + 2] = out[o] ^ 255;
    out[o + 3] = out[o + 1] ^ 255;
    for (var i2 = 0; i2 < s; ++i2)
      out[o + i2 + 4] = dat[i2];
    return (o + 4 + s) * 8;
  };
  var wblk = function(dat, out, final, syms, lf, df, eb, li, bs, bl, p) {
    wbits(out, p++, final);
    ++lf[256];
    var _a2 = hTree(lf, 15), dlt = _a2.t, mlb = _a2.l;
    var _b2 = hTree(df, 15), ddt = _b2.t, mdb = _b2.l;
    var _c = lc(dlt), lclt = _c.c, nlc = _c.n;
    var _d = lc(ddt), lcdt = _d.c, ndc = _d.n;
    var lcfreq = new u16(19);
    for (var i2 = 0; i2 < lclt.length; ++i2)
      ++lcfreq[lclt[i2] & 31];
    for (var i2 = 0; i2 < lcdt.length; ++i2)
      ++lcfreq[lcdt[i2] & 31];
    var _e = hTree(lcfreq, 7), lct = _e.t, mlcb = _e.l;
    var nlcc = 19;
    for (; nlcc > 4 && !lct[clim[nlcc - 1]]; --nlcc)
      ;
    var flen = bl + 5 << 3;
    var ftlen = clen(lf, flt) + clen(df, fdt) + eb;
    var dtlen = clen(lf, dlt) + clen(df, ddt) + eb + 14 + 3 * nlcc + clen(lcfreq, lct) + 2 * lcfreq[16] + 3 * lcfreq[17] + 7 * lcfreq[18];
    if (bs >= 0 && flen <= ftlen && flen <= dtlen)
      return wfblk(out, p, dat.subarray(bs, bs + bl));
    var lm, ll, dm, dl;
    wbits(out, p, 1 + (dtlen < ftlen)), p += 2;
    if (dtlen < ftlen) {
      lm = hMap(dlt, mlb, 0), ll = dlt, dm = hMap(ddt, mdb, 0), dl = ddt;
      var llm = hMap(lct, mlcb, 0);
      wbits(out, p, nlc - 257);
      wbits(out, p + 5, ndc - 1);
      wbits(out, p + 10, nlcc - 4);
      p += 14;
      for (var i2 = 0; i2 < nlcc; ++i2)
        wbits(out, p + 3 * i2, lct[clim[i2]]);
      p += 3 * nlcc;
      var lcts = [lclt, lcdt];
      for (var it = 0; it < 2; ++it) {
        var clct = lcts[it];
        for (var i2 = 0; i2 < clct.length; ++i2) {
          var len = clct[i2] & 31;
          wbits(out, p, llm[len]), p += lct[len];
          if (len > 15)
            wbits(out, p, clct[i2] >> 5 & 127), p += clct[i2] >> 12;
        }
      }
    } else {
      lm = flm, ll = flt, dm = fdm, dl = fdt;
    }
    for (var i2 = 0; i2 < li; ++i2) {
      var sym = syms[i2];
      if (sym > 255) {
        var len = sym >> 18 & 31;
        wbits16(out, p, lm[len + 257]), p += ll[len + 257];
        if (len > 7)
          wbits(out, p, sym >> 23 & 31), p += fleb[len];
        var dst = sym & 31;
        wbits16(out, p, dm[dst]), p += dl[dst];
        if (dst > 3)
          wbits16(out, p, sym >> 5 & 8191), p += fdeb[dst];
      } else {
        wbits16(out, p, lm[sym]), p += ll[sym];
      }
    }
    wbits16(out, p, lm[256]);
    return p + ll[256];
  };
  var deo = /* @__PURE__ */ new i32([65540, 131080, 131088, 131104, 262176, 1048704, 1048832, 2114560, 2117632]);
  var et = /* @__PURE__ */ new u8(0);
  var dflt = function(dat, lvl, plvl, pre, post, st) {
    var s = st.z || dat.length;
    var o = new u8(pre + s + 5 * (1 + Math.ceil(s / 7e3)) + post);
    var w = o.subarray(pre, o.length - post);
    var lst = st.l;
    var pos = (st.r || 0) & 7;
    if (lvl) {
      if (pos)
        w[0] = st.r >> 3;
      var opt = deo[lvl - 1];
      var n = opt >> 13, c = opt & 8191;
      var msk_1 = (1 << plvl) - 1;
      var prev = st.p || new u16(32768), head = st.h || new u16(msk_1 + 1);
      var bs1_1 = Math.ceil(plvl / 3), bs2_1 = 2 * bs1_1;
      var hsh = function(i3) {
        return (dat[i3] ^ dat[i3 + 1] << bs1_1 ^ dat[i3 + 2] << bs2_1) & msk_1;
      };
      var syms = new i32(25e3);
      var lf = new u16(288), df = new u16(32);
      var lc_1 = 0, eb = 0, i2 = st.i || 0, li = 0, wi = st.w || 0, bs = 0;
      for (; i2 + 2 < s; ++i2) {
        var hv = hsh(i2);
        var imod = i2 & 32767, pimod = head[hv];
        prev[imod] = pimod;
        head[hv] = imod;
        if (wi <= i2) {
          var rem = s - i2;
          if ((lc_1 > 7e3 || li > 24576) && (rem > 423 || !lst)) {
            pos = wblk(dat, w, 0, syms, lf, df, eb, li, bs, i2 - bs, pos);
            li = lc_1 = eb = 0, bs = i2;
            for (var j = 0; j < 286; ++j)
              lf[j] = 0;
            for (var j = 0; j < 30; ++j)
              df[j] = 0;
          }
          var l = 2, d = 0, ch_1 = c, dif = imod - pimod & 32767;
          if (rem > 2 && hv == hsh(i2 - dif)) {
            var maxn = Math.min(n, rem) - 1;
            var maxd = Math.min(32767, i2);
            var ml = Math.min(258, rem);
            while (dif <= maxd && --ch_1 && imod != pimod) {
              if (dat[i2 + l] == dat[i2 + l - dif]) {
                var nl = 0;
                for (; nl < ml && dat[i2 + nl] == dat[i2 + nl - dif]; ++nl)
                  ;
                if (nl > l) {
                  l = nl, d = dif;
                  if (nl > maxn)
                    break;
                  var mmd = Math.min(dif, nl - 2);
                  var md = 0;
                  for (var j = 0; j < mmd; ++j) {
                    var ti = i2 - dif + j & 32767;
                    var pti = prev[ti];
                    var cd = ti - pti & 32767;
                    if (cd > md)
                      md = cd, pimod = ti;
                  }
                }
              }
              imod = pimod, pimod = prev[imod];
              dif += imod - pimod & 32767;
            }
          }
          if (d) {
            syms[li++] = 268435456 | revfl[l] << 18 | revfd[d];
            var lin = revfl[l] & 31, din = revfd[d] & 31;
            eb += fleb[lin] + fdeb[din];
            ++lf[257 + lin];
            ++df[din];
            wi = i2 + l;
            ++lc_1;
          } else {
            syms[li++] = dat[i2];
            ++lf[dat[i2]];
          }
        }
      }
      for (i2 = Math.max(i2, wi); i2 < s; ++i2) {
        syms[li++] = dat[i2];
        ++lf[dat[i2]];
      }
      pos = wblk(dat, w, lst, syms, lf, df, eb, li, bs, i2 - bs, pos);
      if (!lst) {
        st.r = pos & 7 | w[pos / 8 | 0] << 3;
        pos -= 7;
        st.h = head, st.p = prev, st.i = i2, st.w = wi;
      }
    } else {
      for (var i2 = st.w || 0; i2 < s + lst; i2 += 65535) {
        var e = i2 + 65535;
        if (e >= s) {
          w[pos / 8 | 0] = lst;
          e = s;
        }
        pos = wfblk(w, pos + 1, dat.subarray(i2, e));
      }
      st.i = s;
    }
    return slc(o, 0, pre + shft(pos) + post);
  };
  var crct = /* @__PURE__ */ (function() {
    var t = new Int32Array(256);
    for (var i2 = 0; i2 < 256; ++i2) {
      var c = i2, k = 9;
      while (--k)
        c = (c & 1 && -306674912) ^ c >>> 1;
      t[i2] = c;
    }
    return t;
  })();
  var crc = function() {
    var c = -1;
    return {
      p: function(d) {
        var cr = c;
        for (var i2 = 0; i2 < d.length; ++i2)
          cr = crct[cr & 255 ^ d[i2]] ^ cr >>> 8;
        c = cr;
      },
      d: function() {
        return ~c;
      }
    };
  };
  var dopt = function(dat, opt, pre, post, st) {
    if (!st) {
      st = { l: 1 };
      if (opt.dictionary) {
        var dict = opt.dictionary.subarray(-32768);
        var newDat = new u8(dict.length + dat.length);
        newDat.set(dict);
        newDat.set(dat, dict.length);
        dat = newDat;
        st.w = dict.length;
      }
    }
    return dflt(dat, opt.level == null ? 6 : opt.level, opt.mem == null ? st.l ? Math.ceil(Math.max(8, Math.min(13, Math.log(dat.length))) * 1.5) : 20 : 12 + opt.mem, pre, post, st);
  };
  var mrg = function(a, b) {
    var o = {};
    for (var k in a)
      o[k] = a[k];
    for (var k in b)
      o[k] = b[k];
    return o;
  };
  var wbytes = function(d, b, v) {
    for (; v; ++b)
      d[b] = v, v >>>= 8;
  };
  function deflateSync(data, opts) {
    return dopt(data, opts || {}, 0, 0);
  }
  var fltn = function(d, p, t, o) {
    for (var k in d) {
      var val = d[k], n = p + k, op = o;
      if (Array.isArray(val))
        op = mrg(o, val[1]), val = val[0];
      if (ArrayBuffer.isView(val))
        t[n] = [val, op];
      else {
        t[n += "/"] = [new u8(0), op];
        fltn(val, n, t, o);
      }
    }
  };
  var te = typeof TextEncoder != "undefined" && /* @__PURE__ */ new TextEncoder();
  var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder();
  var tds = 0;
  try {
    td.decode(et, { stream: true });
    tds = 1;
  } catch (e) {
  }
  function strToU8(str, latin1) {
    if (latin1) {
      var ar_1 = new u8(str.length);
      for (var i2 = 0; i2 < str.length; ++i2)
        ar_1[i2] = str.charCodeAt(i2);
      return ar_1;
    }
    if (te)
      return te.encode(str);
    var l = str.length;
    var ar = new u8(str.length + (str.length >> 1));
    var ai = 0;
    var w = function(v) {
      ar[ai++] = v;
    };
    for (var i2 = 0; i2 < l; ++i2) {
      if (ai + 5 > ar.length) {
        var n = new u8(ai + 8 + (l - i2 << 1));
        n.set(ar);
        ar = n;
      }
      var c = str.charCodeAt(i2);
      if (c < 128 || latin1)
        w(c);
      else if (c < 2048)
        w(192 | c >> 6), w(128 | c & 63);
      else if (c > 55295 && c < 57344)
        c = 65536 + (c & 1023 << 10) | str.charCodeAt(++i2) & 1023, w(240 | c >> 18), w(128 | c >> 12 & 63), w(128 | c >> 6 & 63), w(128 | c & 63);
      else
        w(224 | c >> 12), w(128 | c >> 6 & 63), w(128 | c & 63);
    }
    return slc(ar, 0, ai);
  }
  var exfl = function(ex) {
    var le = 0;
    if (ex) {
      for (var k in ex) {
        var l = ex[k].length;
        if (l > 65535)
          err(9);
        le += l + 4;
      }
    }
    return le;
  };
  var wzh = function(d, b, f, fn, u, c, ce, co) {
    var fl2 = fn.length, ex = f.extra, col = co && co.length;
    var exl = exfl(ex);
    wbytes(d, b, ce != null ? 33639248 : 67324752), b += 4;
    if (ce != null)
      d[b++] = 20, d[b++] = f.os;
    d[b] = 20, b += 2;
    d[b++] = f.flag << 1 | (c < 0 && 8), d[b++] = u && 8;
    d[b++] = f.compression & 255, d[b++] = f.compression >> 8;
    var dt = new Date(f.mtime == null ? Date.now() : f.mtime), y = dt.getFullYear() - 1980;
    if (y < 0 || y > 119)
      err(10);
    wbytes(d, b, y << 25 | dt.getMonth() + 1 << 21 | dt.getDate() << 16 | dt.getHours() << 11 | dt.getMinutes() << 5 | dt.getSeconds() >> 1), b += 4;
    if (c != -1) {
      wbytes(d, b, f.crc);
      wbytes(d, b + 4, c < 0 ? -c - 2 : c);
      wbytes(d, b + 8, f.size);
    }
    wbytes(d, b + 12, fl2);
    wbytes(d, b + 14, exl), b += 16;
    if (ce != null) {
      wbytes(d, b, col);
      wbytes(d, b + 6, f.attrs);
      wbytes(d, b + 10, ce), b += 14;
    }
    d.set(fn, b);
    b += fl2;
    if (exl) {
      for (var k in ex) {
        var exf = ex[k], l = exf.length;
        wbytes(d, b, +k);
        wbytes(d, b + 2, l);
        d.set(exf, b + 4), b += 4 + l;
      }
    }
    if (col)
      d.set(co, b), b += col;
    return b;
  };
  var wzf = function(o, b, c, d, e) {
    wbytes(o, b, 101010256);
    wbytes(o, b + 8, c);
    wbytes(o, b + 10, c);
    wbytes(o, b + 12, d);
    wbytes(o, b + 16, e);
  };
  function zipSync(data, opts) {
    if (!opts)
      opts = {};
    var r = {};
    var files = [];
    fltn(data, "", r, opts);
    var o = 0;
    var tot = 0;
    for (var fn in r) {
      var _a2 = r[fn], file = _a2[0], p = _a2[1];
      var compression = p.level == 0 ? 0 : 8;
      var f = strToU8(fn), s = f.length;
      var com = p.comment, m = com && strToU8(com), ms = m && m.length;
      var exl = exfl(p.extra);
      if (s > 65535)
        err(11);
      var d = compression ? deflateSync(file, p) : file, l = d.length;
      var c = crc();
      c.p(file);
      files.push(mrg(p, {
        size: file.length,
        crc: c.d(),
        c: d,
        f,
        m,
        u: s != fn.length || m && com.length != ms,
        o,
        compression
      }));
      o += 30 + s + exl + l;
      tot += 76 + 2 * (s + exl) + (ms || 0) + l;
    }
    var out = new u8(tot + 22), oe = o, cdl = tot - o;
    for (var i2 = 0; i2 < files.length; ++i2) {
      var f = files[i2];
      wzh(out, f.o, f, f.f, f.u, f.c.length);
      var badd = 30 + f.f.length + exfl(f.extra);
      out.set(f.c, f.o + badd);
      wzh(out, o, f, f.f, f.u, f.c.length, f.o, f.m), o += 16 + badd + (f.m ? f.m.length : 0);
    }
    wzf(out, o, files.length, cdl, oe);
    return out;
  }

  function saveAs(blob, filename) {
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 5e3);
  }
  function nodeStatus(b) {
    const main = b.outcomes?.getPerformanceDashboard?.status;
    if (main !== "data") return main === "empty" || main === "no-content" ? "\u65E0\u6709\u6548\u4E3B\u6570\u636E" : "\u4E3B\u6570\u636E\u672A\u6210\u529F";
    return KINDS.every((k) => ["data", "empty", "no-content"].includes(b.outcomes?.[k]?.status || "")) ? "\u5DF2\u5B8C\u6210" : "\u90E8\u5206\u5B8C\u6210";
  }
  function metadata(b) {
    const outcomes = b.outcomes || {};
    return {
      schema_version: 1,
      script_version: VERSION,
      node_id: b.nodeId,
      captured_at: new Date(b.createdAt).toISOString(),
      updated_at: new Date(b.updatedAt).toISOString(),
      page_url: b.pageUrl,
      store: b.ctx.store,
      category: b.ctx.category,
      product_type: b.ctx.product_type,
      keyword: b.ctx.keyword,
      file_count: Object.keys(b.files).length,
      response_types: Object.keys(b.files),
      response_files: Object.values(b.files).map((f) => f.name),
      capture_batch_id: b.key,
      capture_round: b.round,
      path_codes: b.path,
      export_batch_id: b.exportId || null,
      supplement_of: b.supplementOf || null,
      task_id: b.taskId || null,
      source: b.taskId ? "active-api" : "legacy-capture",
      node_status: nodeStatus(b),
      interface_results: outcomes,
      business_data_count: Object.values(outcomes).filter((o) => o.status === "data").length,
      empty_response_count: Object.values(outcomes).filter((o) => ["empty", "no-content"].includes(o.status)).length,
      error_count: Object.values(outcomes).filter((o) => ["failed", "interrupted"].includes(o.status)).length,
      missing_types: KINDS.filter((k) => !["data", "empty", "no-content"].includes(outcomes[k]?.status || ""))
    };
  }
  var Downloads = class {
    constructor(engine2, log2, saver = saveAs) {
      this.engine = engine2;
      this.log = log2;
      this.saver = saver;
    }
    engine;
    log;
    saver;
    busy = false;
    zip(entries, filename) {
      const bytes = zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strToU8(v)])), { level: 6 });
      this.saver(new Blob([bytes], { type: "application/zip" }), filename);
      this.log("I", `\u5DF2\u89E6\u53D1\u4E0B\u8F7D ${filename}\uFF5C${bytes.length}\u5B57\u8282\uFF1B\u8BF7\u68C0\u67E5\u6D4F\u89C8\u5668\u4E0B\u8F7D\u8BB0\u5F55`);
    }
    async batches(keys, tag = "\u624B\u52A8") {
      if (this.busy) {
        this.log("W", "\u5DF2\u6709\u4E0B\u8F7D\u6253\u5305\u4EFB\u52A1\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
        return false;
      }
      this.busy = true;
      try {
        const snapshots = await this.engine.snapshots(keys);
        if (!snapshots.length) {
          this.log("W", "\u6CA1\u6709\u53EF\u4E0B\u8F7D\u7684\u8282\u70B9");
          return false;
        }
        const groups = [];
        for (const b of snapshots) {
          let group = groups.find((g) => !g.some((x2) => x2.nodeId === b.nodeId));
          if (!group) {
            group = [];
            groups.push(group);
          }
          group.push(b);
        }
        for (const group of groups) {
          const id = `export-${stamp()}-${Math.random().toString(36).slice(2)}`, entries = {};
          for (const b of group) {
            const dir = `${b.nodeId}_${Object.keys(b.files).length}`;
            for (const f of Object.values(b.files)) {
              if (f.text === void 0) throw new Error("\u6B63\u6587\u4E0D\u5728\u53EF\u7528\u5B58\u50A8\u4E2D\uFF0C\u505C\u6B62\u5BFC\u51FA");
              entries[`${dir}/${f.name}`] = f.text;
            }
            entries[`${dir}/NODE\u4E28${b.nodeId}\u4E28${stamp()}.json`] = JSON.stringify({ ...metadata(b), export_batch_id: id }, null, 2);
          }
          const task = this.engine.task;
          const problems = [...this.engine.batches.values()].filter((b) => b.taskId === task?.id && nodeStatus(b) !== "\u5DF2\u5B8C\u6210").map((b) => ({ path: b.path, node_id: b.nodeId, node_status: nodeStatus(b), interface_results: b.outcomes }));
          entries["\u91C7\u96C6\u62A5\u544A.json"] = JSON.stringify({
            script_version: VERSION,
            export_batch_id: id,
            download_status: "triggered",
            tag,
            task: task ? { id: task.id, status: task.status, reason: task.reason, saved_node_count: task.count, config: task.config, current: task.current, problems } : null,
            nodes: group.map(metadata)
          }, null, 2);
          this.zip(entries, `AMZ\u4E28\u7C7B\u76EE\u5206\u6790\u6570\u636E\u6293\u53D6\u4E28${group.some((b) => b.supplementOf) ? "\u8865\u5145" : tag}\u4E28${group.length}\u4E28${stamp()}.zip`);
          await this.engine.remove(group.map((b) => b.key), true);
        }
        return true;
      } catch (e) {
        this.log("E", `\u4E0B\u8F7D\u5931\u8D25\uFF0C\u6570\u636E\u4FDD\u7559\uFF1A${String(e)}`);
        return false;
      } finally {
        this.busy = false;
      }
    }
  };

  function installLayout(root) {
    const get = (id) => root.getElementById(id);
    const panel = get("panel"), workspace = get("workspace"), list = get("list");
    const section = get("log-section"), logs2 = get("logs"), divider = get("divider");
    const minimize = get("minimize"), restore = get("restore-title");
    let ratio = 0.58, dragging = null;
    let saved = { list: 0, log: 0, logAtBottom: true };
    const bounds = () => {
      const available = Math.max(0, workspace.clientHeight - divider.getBoundingClientRect().height);
      return { available, min: Math.min(60, available / 2), max: Math.max(0, available - Math.min(72, available / 2)) };
    };
    const apply = (requested) => {
      if (panel.hidden) return;
      const { available, min, max } = bounds();
      if (!available) return;
      const height = Math.max(min, Math.min(max, requested ?? ratio * available));
      ratio = height / available;
      list.style.flex = `0 0 ${height}px`;
      section.style.flex = "1 1 0px";
      divider.setAttribute("aria-valuemin", String(Math.round(min / available * 100)));
      divider.setAttribute("aria-valuemax", String(Math.round(max / available * 100)));
      divider.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
    };
    const endDrag = () => {
      dragging = null;
      workspace.classList.remove("resizing");
    };
    divider.onpointerdown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      dragging = e.pointerId;
      divider.setPointerCapture(e.pointerId);
      workspace.classList.add("resizing");
    };
    divider.onpointermove = (e) => {
      if (dragging !== e.pointerId) return;
      apply(e.clientY - workspace.getBoundingClientRect().top - divider.getBoundingClientRect().height / 2);
    };
    divider.onpointerup = divider.onpointercancel = divider.onlostpointercapture = endDrag;
    divider.onkeydown = (e) => {
      const { available, min, max } = bounds();
      const delta = e.shiftKey ? 30 : 12;
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      apply(e.key === "Home" ? min : e.key === "End" ? max : ratio * available + (e.key === "ArrowDown" ? delta : -delta));
    };
    minimize.onclick = () => {
      endDrag();
      const rect = panel.getBoundingClientRect();
      saved = { list: list.scrollTop, log: logs2.scrollTop, logAtBottom: logs2.scrollHeight - logs2.scrollTop - logs2.clientHeight < 30 };
      restore.style.left = `${rect.left}px`;
      restore.style.top = `${rect.top}px`;
      panel.hidden = true;
      restore.hidden = false;
      restore.focus();
    };
    restore.onclick = () => {
      restore.hidden = true;
      panel.hidden = false;
      apply();
      list.scrollTop = saved.list;
      logs2.scrollTop = saved.logAtBottom ? logs2.scrollHeight : saved.log;
      minimize.focus();
    };
    const observer = new ResizeObserver(() => apply());
    observer.observe(workspace);
    apply();
  }

  var logs = [];
  var render = () => {
  };
  var renderLog = () => {
  };
  var log = (level, message) => {
    logs.push({ at: (/* @__PURE__ */ new Date()).toISOString(), level, message });
    if (logs.length > 3e3) logs.shift();
    renderLog();
  };
  var cache = new DirectoryCache(log, () => render());
  var nativeFetch = installFilterHooks(cache, log);
  var storage = new BrowserStore();
  var engine = new Collector(storage, cache, nativeFetch, log, () => render());
  var downloads = new Downloads(engine, log);
  engine.exporter = (keys, tag) => downloads.batches(keys, tag);
  var ready = engine.restore();
  var config = structuredClone(DEFAULTS);
  var initialized = false;
  var groupLabels = { keyword: "\u5173\u952E\u8BCD", ptype: "\u5546\u54C1\u7C7B\u578B", category: "\u7C7B\u522B", store: "\u5546\u57CE" };
  var checked = (e) => e.checked === true || e.getAttribute("aria-checked") === "true" || e.hasAttribute("checked") && e.getAttribute("checked") !== "false";
  function readContext() {
    const read = (level) => {
      const items = [...document.querySelectorAll(`kat-radiobutton[name="${FILTER_NAMES[level]}"]`)];
      const selected = items.filter(checked);
      if (selected.length !== 1) throw new Error(`\u8BF7\u5728\u539F\u9875\u9762\u660E\u786E\u9009\u62E9${groupLabels[level]}`);
      const e = selected[0], value = e.getAttribute("value");
      if (!value) throw new Error(`${groupLabels[level]}\u4EE3\u7801\u4E3A\u7A7A`);
      return { value, label: e.getAttribute("label") || value, index: items.indexOf(e) + 1, total: items.length };
    };
    const choose = (selected, items, label) => {
      if (!items) return selected;
      const matched = items.find((x2) => x2.value === selected.value);
      if (!matched) throw new Error(`${label}\u8D77\u70B9\u4E0D\u5728\u5DF2\u76D1\u542C\u76EE\u5F55\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9`);
      return matched;
    };
    const store = choose(read("store"), cache.get("MP"), "\u5546\u57CE");
    const category = choose(read("category"), cache.get("MP_CAT", store.value), "\u7C7B\u522B");
    const product_type = choose(read("ptype"), cache.get("MP_CAT_PTD", store.value, category.value), "\u5546\u54C1\u7C7B\u578B");
    const keyword = choose(read("keyword"), cache.get("MP_CAT_PTD_BN", store.value, category.value, product_type.value), "\u5173\u952E\u8BCD");
    return { store, category, product_type, keyword, nodeId: keyword.value };
  }
  async function start(resume = false) {
    if (engine.running) return;
    await ready;
    if (!initialized) throw new Error("\u521D\u59CB\u5316\u5C1A\u672A\u5B8C\u6210");
    const start2 = resume && engine.task ? engine.task.start : readContext();
    if (!navigator.locks) throw new Error("\u5F53\u524D\u6D4F\u89C8\u5668\u4E0D\u652F\u6301 Web Locks\uFF0C\u8BF7\u4F7F\u7528\u65B0\u7248 Chrome");
    await navigator.locks.request("amz_category_node_mapper_v1_active_tab", { ifAvailable: true }, async (lock) => {
      if (!lock) {
        log("W", "\u5DF2\u6709\u91C7\u96C6\u4EFB\u52A1\u8FD0\u884C\uFF0C\u8BF7\u5148\u7EC8\u6B62\u5176\u4ED6\u6807\u7B7E\u9875\u6216\u8282\u70B9\u6620\u5C04\u91C7\u96C6\u5668");
        return;
      }
      await engine.run(start2, config, resume);
    });
  }
  function safe(work) {
    return () => {
      try {
        Promise.resolve(work()).catch((e) => log("E", String(e)));
      } catch (e) {
        log("E", String(e));
      }
    };
  }
  async function boot() {
    if (!document.body) {
      setTimeout(() => void boot(), 100);
      return;
    }
    const host = document.createElement("div");
    host.id = "amz-category-insights-v7";
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
    :host{all:initial}*{box-sizing:border-box}#panel{position:fixed;top:10px;left:10px;z-index:2147483646;background:rgba(20,20,20,.95);color:#eee;font:12px Arial,sans-serif;padding:8px;border-radius:6px;box-shadow:0 4px 12px #0008;width:min(470px,calc(100vw - 20px));height:min(620px,92vh);min-height:330px;resize:vertical;overflow:hidden;display:flex;flex-direction:column}
    #header{display:flex;justify-content:space-between;gap:6px;cursor:move;font-weight:bold;margin-bottom:6px}#stats{font-size:11px;color:#9ccc65;font-weight:normal}#config{background:#ffffff10;padding:6px;border-radius:4px} .row{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin:4px 0}label{display:inline-flex;align-items:center;gap:3px}input[type=number]{width:52px;background:#222;color:#fff;border:1px solid #555;border-radius:3px;padding:2px;font:inherit}input[type=checkbox]{margin:0}button{font:inherit;border:1px solid #555;background:#333;color:#fff;border-radius:4px;padding:3px 6px;cursor:pointer}button:disabled{opacity:.5;cursor:default}.primary{background:#388e3c}.danger{background:#b71c1c}.warn{background:#a45a00}#progress,#preview{font-size:11px;color:#90caf9;overflow-wrap:anywhere;margin-top:5px}#list{flex:1;min-height:50px;overflow:auto}.node{border:1px solid #555;border-radius:4px;padding:5px;margin:4px 0}.name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.small{font-size:11px;color:#aaa;overflow-wrap:anywhere}.tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:4px}.tag{font-size:10px;padding:2px 4px;background:#444;border-radius:3px}.data{background:#1565c0}.empty,.no-content{background:#6d4c41}.failed,.interrupted{background:#b71c1c}.pending{background:#555}#loghead{display:flex;align-items:center;justify-content:space-between;margin:6px 0 3px}#logs{height:150px;min-height:60px;overflow:auto;flex-shrink:0;background:#0006;padding:4px 6px;font:11px/1.5 Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.I{color:#c8e6c9}.W{color:#ffd54f}.E{color:#ff8a80}
    #panel[hidden],#restore-title[hidden]{display:none}#header,#config,#actions{flex-shrink:0}#header{align-items:center}#header>span:first-child{min-width:0;flex:1}#minimize{flex-shrink:0;padding:0 5px;font-size:15px;line-height:18px}#workspace{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}#list{min-height:0}#log-section{display:flex;flex-direction:column;min-height:0;overflow:hidden}#loghead{flex-shrink:0;margin-top:0}#logs{flex:1;min-height:0;height:auto}#divider{height:10px;flex:0 0 10px;cursor:row-resize;touch-action:none;display:flex;align-items:center;justify-content:center;outline:none}#divider:before{content:'';height:3px;width:64px;border-radius:3px;background:#777}#divider:hover:before,#divider:focus-visible:before{background:#90caf9}#workspace.resizing{user-select:none;cursor:row-resize}#restore-title{position:fixed;z-index:2147483646;max-width:calc(100vw - 20px);padding:7px 10px;background:rgba(20,20,20,.95);color:#eee;border:1px solid #666;box-shadow:0 3px 8px #0006;font:bold 12px Arial,sans-serif;text-align:left}
    </style><button id="restore-title" type="button" hidden aria-label="\u6062\u590D\u91C7\u96C6\u6D6E\u7A97">Amazon \u7C7B\u76EE\u6D1E\u5BDF\u6570\u636E\u91C7\u96C6\u5668 v${VERSION}</button><section id="panel"><header id="header"><span>Amazon \u7C7B\u76EE\u6D1E\u5BDF\u6570\u636E\u91C7\u96C6\u5668 v${VERSION}</span><span id="stats"></span><button id="minimize" type="button" title="\u6700\u5C0F\u5316" aria-label="\u6700\u5C0F\u5316\u91C7\u96C6\u6D6E\u7A97">\u2212</button></header>
    <div id="config"><div class="row">\u81EA\u52A8\u904D\u5386\uFF1A${["store", "category", "ptype", "keyword"].map((k) => `<label><input type="checkbox" data-level="${k}" ${config.levels[k] ? "checked" : ""}>${groupLabels[k]}</label>`).join("")}</div>
    <div class="row">\u6BCF\u6279\u4E0B\u8F7D <input id="target" type="number" min="1" value="50"> \u4E2A\u8282\u70B9\u3000\u603B\u6570\u91CF <input id="limit" type="number" min="0" value="0"> \u4E2A\u8282\u70B9\uFF080=\u4E0D\u9650\uFF09</div>
    <div class="row">\u8282\u70B9\u95F4\u968F\u673A\u5EF6\u8FDF <input id="min" type="number" min="15" value="15"> \uFF5E <input id="max" type="number" min="15" value="45"> \u79D2\uFF08\u6700\u4F4E15\u79D2\uFF09</div>
    <div class="row"><button id="start" class="primary">\u5F00\u59CB\u6293\u53D6</button><button id="stop" class="warn">\u7EC8\u6B62\u6293\u53D6</button><button id="resume">\u7EE7\u7EED\u672A\u5B8C\u6210\u4EFB\u52A1</button></div><div id="preview"></div><div id="progress"></div></div>
    <div id="actions" class="row"><button id="all">\u5168\u9009</button><button id="invert">\u53CD\u9009</button><button id="download" class="primary">\u4E0B\u8F7D\u9009\u4E2D</button><button id="delete" class="danger">\u5220\u9664\u9009\u4E2D</button><button id="delete-all" class="danger">\u5220\u9664\u5168\u90E8</button></div>
    <div id="workspace"><div id="list"></div><div id="divider" role="separator" tabindex="0" aria-label="\u8C03\u6574\u8282\u70B9\u5217\u8868\u4E0E\u8FD0\u884C\u65E5\u5FD7\u9AD8\u5EA6" aria-orientation="horizontal" aria-controls="list log-section" title="\u62D6\u52A8\u8C03\u6574\u5217\u8868\u548C\u65E5\u5FD7\u9AD8\u5EA6\uFF1B\u652F\u6301\u4E0A\u4E0B\u65B9\u5411\u952E"></div><div id="log-section"><div id="loghead"><b>\u8FD0\u884C\u65E5\u5FD7</b><div><button id="log-download">\u4E0B\u8F7D\u65E5\u5FD7</button> <button id="log-clear">\u6E05\u7A7A\u65E5\u5FD7</button></div></div><div id="logs"></div></div></div></section>`;
    const element = (id) => root.getElementById(id);
    const input = (id) => element(id);
    const button = (id, fn) => element(id).onclick = safe(fn);
    const selected = () => engine.visible().filter((b) => b.checked).map((b) => b.key);
    const updateConfig = () => {
      config = normalizeConfig({ ...config, target: Number(input("target").value), totalLimit: Number(input("limit").value), delayMin: Number(input("min").value), delayMax: Number(input("max").value) });
      input("target").value = String(config.target);
      input("limit").value = String(config.totalLimit);
      input("min").value = String(config.delayMin);
      input("max").value = String(config.delayMax);
      render();
    };
    for (const id of ["target", "limit", "min", "max"]) input(id).onchange = updateConfig;
    for (const cb of root.querySelectorAll("[data-level]")) cb.onchange = () => {
      const k = cb.dataset.level, i2 = LEVELS.indexOf(k);
      config.levels[k] = cb.checked;
      if (cb.checked) for (let j = 0; j < i2; j++) config.levels[LEVELS[j]] = true;
      else for (let j = i2 + 1; j < LEVELS.length; j++) config.levels[LEVELS[j]] = false;
      config = normalizeConfig(config);
      render();
    };
    button("start", () => {
      updateConfig();
      return start();
    });
    button("stop", () => engine.stop());
    button("resume", () => start(true));
    button("all", () => {
      for (const b of engine.visible()) b.checked = true;
      render();
    });
    button("invert", () => {
      for (const b of engine.visible()) b.checked = !b.checked;
      render();
    });
    button("download", () => {
      const keys = selected();
      if (!keys.length) {
        log("W", "\u8BF7\u5148\u9009\u62E9\u8282\u70B9");
        return;
      }
      return downloads.batches(keys);
    });
    const remove = async (keys) => {
      if (keys.length && confirm(`\u786E\u8BA4\u5B8C\u5168\u5220\u9664\u5F53\u524D\u5217\u8868\u4E2D\u7684 ${keys.length}\u4E2A\u8282\u70B9\u8BB0\u5F55\u53CA\u5176 IndexedDB \u6570\u636E\uFF1F\u5220\u9664\u540E\u4E0D\u80FD\u8865\u4E0B\u8F7D\uFF0C\u5DF2\u4E0B\u8F7D\u5230\u78C1\u76D8\u7684\u6587\u4EF6\u4E0D\u53D7\u5F71\u54CD\u3002`)) await engine.remove(keys);
    };
    button("delete", () => remove(selected()));
    button("delete-all", () => remove(engine.visible().map((b) => b.key)));
    button("log-download", () => saveAs(new Blob([`Amazon \u7C7B\u76EE\u6D1E\u5BDF\u6570\u636E\u91C7\u96C6\u5668 v${VERSION}
\u9875\u9762\uFF1A${location.href}
${logs.map((l) => `[${l.at}] [${l.level}] ${l.message}`).join("\n")}`], { type: "text/plain;charset=utf-8" }), `\u7C7B\u76EE\u6570\u636E\u6293\u53D6_v${VERSION}_${stamp()}.log`));
    button("log-clear", () => {
      logs.length = 0;
      renderLog();
    });
    renderLog = () => {
      const box = element("logs"), atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30, scroll = box.scrollTop;
      box.replaceChildren(...logs.slice(-800).map((l) => {
        const el = document.createElement("div");
        el.className = l.level;
        el.textContent = `[${l.at.slice(11, 23)}] ${l.message}`;
        return el;
      }));
      box.scrollTop = atBottom ? box.scrollHeight : scroll;
    };
    const row = (b) => {
      const div = document.createElement("div");
      div.className = "node";
      div.dataset.key = b.key;
      const top = document.createElement("div");
      top.className = "row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = b.checked;
      cb.onchange = () => {
        b.checked = cb.checked;
      };
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = `${b.ctx.keyword.label}\uFF08${b.nodeId}\uFF09[${Object.keys(b.files).length}/4]`;
      name.title = contextLabel(b.ctx);
      const dl = document.createElement("button");
      dl.textContent = "\u4E0B\u8F7D";
      dl.onclick = safe(() => downloads.batches([b.key], "\u5355\u8282\u70B9"));
      const del = document.createElement("button");
      del.textContent = "\u5220\u9664";
      del.onclick = safe(() => remove([b.key]));
      top.append(cb, name, dl, del);
      const sub = document.createElement("div");
      sub.className = "small";
      sub.textContent = `${b.ctx.category.label} / ${b.ctx.product_type.label}\uFF5C${nodeStatus(b)}`;
      const tags = document.createElement("div");
      tags.className = "tags";
      for (const k of KINDS) {
        const t = document.createElement("span"), o = b.outcomes?.[k];
        t.className = `tag ${o?.status || "pending"}`;
        t.textContent = `${LABELS[k]}\uFF1A${{ data: "\u6709\u6570\u636E", empty: "\u65E0\u6570\u636E", "no-content": "\u65E0\u6B63\u6587", failed: "\u5931\u8D25", interrupted: "\u4E2D\u65AD", pending: "\u8BF7\u6C42\u4E2D" }[o?.status || "pending"]}`;
        t.title = o?.reason || "";
        tags.append(t);
      }
      div.append(top, sub, tags);
      return div;
    };
    render = () => {
      const running = engine.running, visible = engine.visible();
      element("stats").textContent = `\u8282\u70B9 ${visible.length} \xB7 \u6587\u4EF6 ${visible.reduce((s, b) => s + Object.keys(b.files).length, 0)}`;
      for (const cb of root.querySelectorAll("[data-level]")) {
        const k = cb.dataset.level;
        cb.checked = config.levels[k];
        cb.disabled = k === "keyword" || running;
      }
      for (const id of ["target", "limit", "min", "max"]) input(id).disabled = running;
      element("start").disabled = running || !initialized;
      element("stop").disabled = !running;
      element("resume").disabled = running || !initialized || !engine.task;
      element("start").textContent = running ? "\u6293\u53D6\u4E2D\u2026" : "\u5F00\u59CB\u6293\u53D6";
      let c = engine.task?.current || engine.task?.start;
      if (!running) {
        try {
          const gui = readContext();
          element("preview").textContent = `\u8D77\u70B9\uFF1A${contextLabel(gui)}\uFF5C\u4ECE\u5F53\u524D\u9879\u5230\u672B\u5C3E`;
        } catch (e) {
          element("preview").textContent = String(e);
        }
      } else element("preview").textContent = `\u5F53\u524D\uFF1A${c ? contextLabel(c) : "\u9A8C\u8BC1\u8D77\u70B9\u76EE\u5F55"}\uFF5C\u4EFB\u52A1\u8303\u56F4\u5DF2\u9501\u5B9A`;
      if (!c) {
        try {
          c = readContext();
        } catch {
        }
      }
      element("progress").textContent = `\u5173\u952E\u8BCD ${c?.keyword.index || 0}/${c?.keyword.total || 0}\u3000\u5546\u54C1\u7C7B\u578B ${c?.product_type.index || 0}/${c?.product_type.total || 0}\u3000\u7C7B\u522B ${c?.category.index || 0}/${c?.category.total || 0}\u3000\u5546\u5E97 ${c?.store.index || 0}/${c?.store.total || 0}\u3000\uFF5C\u672C\u6B21\u5DF2\u4FDD\u5B58 ${engine.task?.count || 0}${engine.task?.config.totalLimit ? " / " + engine.task.config.totalLimit : ""}`;
      const list = element("list"), scroll = list.scrollTop;
      list.replaceChildren(...visible.map(row));
      if (!visible.length) {
        const empty = document.createElement("div");
        empty.className = "small";
        empty.textContent = "\u6682\u65E0\u5F85\u4E0B\u8F7D\u6570\u636E\uFF0C\u70B9\u51FB\u5F00\u59CB\u6293\u53D6\u540E\u663E\u793A\u7ED3\u679C\u3002";
        list.append(empty);
      }
      list.scrollTop = scroll;
    };
    let dragging = null;
    const panel = element("panel");
    element("header").onpointerdown = (e) => {
      if (e.button !== 0 || e.target.closest("button")) return;
      const rect = panel.getBoundingClientRect();
      dragging = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      element("header").setPointerCapture(e.pointerId);
    };
    element("header").onpointermove = (e) => {
      if (dragging) {
        panel.style.left = `${Math.max(0, e.clientX - dragging.x)}px`;
        panel.style.top = `${Math.max(0, e.clientY - dragging.y)}px`;
      }
    };
    element("header").onpointerup = () => {
      dragging = null;
    };
    installLayout(root);
    renderLog();
    render();
    try {
      await ready;
      initialized = true;
      log("I", `v${VERSION} \u672C\u5730\u7248\u5C31\u7EEA\uFF1B\u56DB\u8BF7\u6C42\u4E3B\u52A8\u91C7\u96C6\uFF0C\u8282\u70B9\u95F4\u9ED8\u8BA415\u201345\u79D2\uFF0C\u6700\u4F4E15\u79D2`);
    } catch (e) {
      log("E", `\u521D\u59CB\u5316\u5931\u8D25\uFF0C\u8BF7\u4FDD\u7559\u65E7\u9875\u9762\u5E76\u68C0\u67E5\u5B58\u50A8\uFF1A${String(e)}`);
    }
    render();
    setInterval(render, 1500);
  }
  void ready.catch((e) => log("E", `\u6062\u590D\u5931\u8D25\uFF1A${String(e)}`));
  void boot();
})();
