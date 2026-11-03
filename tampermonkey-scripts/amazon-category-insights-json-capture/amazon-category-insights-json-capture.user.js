// ==UserScript==
// @name         Amazon 类目洞察数据采集器
// @namespace    http://tampermonkey.net/
// @version      6.7.0
// @description  采集类目表现、畅销/新品 ASIN 与产品特征趋势；逐请求验证归属、隔离异常响应、支持迟到补录及 JSON ZIP 导出。
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
(() => {
  // Capture module: core.ts
  var VERSION = "6.7.0";
  var TYPES = ["getPerformanceDashboard", "relatedAsin_top_grossing", "relatedAsin_new_successful", "getFeaturesDashboard"];
  var aliases = {
    browseNode: "node",
    browseNodeId: "node",
    nodeId: "node",
    bnId: "node",
    targetMarketplaceId: "market",
    marketplaceId: "market",
    marketId: "market",
    catId: "category",
    categoryId: "category",
    ptdId: "product",
    productTypeId: "product",
    relatedAsinType: "variant",
    asinType: "variant",
    dashboardType: "variant",
    type: "variant"
  };
  var scalar = (x2) => typeof x2 === "string" && x2.trim() ? x2 : typeof x2 === "number" && Number.isSafeInteger(x2) ? String(x2) : void 0;
  var object = (x2) => x2 !== null && typeof x2 === "object" && !Array.isArray(x2);
  function evidence(value) {
    const out = { node: [], market: [], category: [], product: [], variant: [], invalid: false };
    let count = 0;
    function add(key, v) {
      const bucket = aliases[key];
      if (!bucket) return;
      const s = scalar(v);
      if (s !== void 0) {
        if (!out[bucket].includes(s)) out[bucket].push(s);
      } else if (v !== null && v !== void 0) out.invalid = true;
    }
    function visit(v, depth) {
      if (++count > 1e4 || depth > 16) {
        out.invalid = true;
        return;
      }
      if (Array.isArray(v)) {
        for (const x2 of v) visit(x2, depth + 1);
        return;
      }
      if (!object(v)) return;
      if (typeof v.key === "string" && "value" in v) add(v.key, v.value);
      for (const [k, x2] of Object.entries(v)) {
        if (aliases[k]) add(k, x2);
        if (["filter", "filters", "request", "parameters", "params", "context", "metadata"].includes(k)) visit(x2, depth + 1);
      }
    }
    visit(value, 0);
    return out;
  }
  function parseBody(body) {
    if (body instanceof URLSearchParams) return Object.fromEntries(body);
    if (typeof body === "string") {
      try {
        return JSON.parse(body);
      } catch {
        if (body.includes("=")) return Object.fromEntries(new URLSearchParams(body));
      }
      return null;
    }
    return object(body) ? body : null;
  }
  function pathOf(c) {
    return [c.store.value, c.category.value, c.product_type.value, c.keyword.value];
  }
  var same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  var full = (p) => p.every(Boolean);
  function endpoint(url) {
    const parsed = new URL(url, "https://sellercentral.amazon.com");
    if (parsed.origin !== "https://sellercentral.amazon.com") return "";
    const p = parsed.pathname;
    return ["/next/v2/getPerformanceDashboard", "/next/v2/getFeaturesDashboard", "/next/v2/relatedAsinDashboard", "/next/v2/getFilters"].includes(p) ? p.split("/").pop() : "";
  }
  function merge(a, b) {
    return { node: [.../* @__PURE__ */ new Set([...a.node, ...b.node])], market: [.../* @__PURE__ */ new Set([...a.market, ...b.market])], category: [.../* @__PURE__ */ new Set([...a.category, ...b.category])], product: [.../* @__PURE__ */ new Set([...a.product, ...b.product])], variant: [.../* @__PURE__ */ new Set([...a.variant, ...b.variant])], invalid: a.invalid || b.invalid };
  }
  function conflict(e) {
    return e.invalid || [e.node, e.market, e.category, e.product].some((x2) => x2.length > 1);
  }
  function metricEvidence(json, context) {
    const out = evidence(null);
    if (!object(json)) return out;
    let count = 0;
    function visit(value, depth = 0) {
      if (!object(value) || depth > 5 || ++count > 3e3) return;
      if (typeof value.id === "string") {
        const variant = /^(top_grossing|new_successful)_/.exec(value.id)?.[1];
        if (variant && !out.variant.includes(variant)) out.variant.push(variant);
        const prefixes = [context.category.label, context.category.value].filter(Boolean).map((c) => `${c}_${context.product_type.value}_`);
        for (const prefix of prefixes) if (value.id.startsWith(prefix)) {
          const node = /^(\d+)_/.exec(value.id.slice(prefix.length))?.[1];
          if (node && !out.node.includes(node)) out.node.push(node);
        }
      }
      for (const [key, v] of Object.entries(value)) if (!["graphDataPointsList", "relatedASINs", "asinList"].includes(key)) visit(v, depth + 1);
    }
    visit(json.demand);
    visit(json.competition);
    return out;
  }
  var CaptureEngine = class {
    constructor(store, log, changed = () => {
    }, pageUrl = "") {
      this.store = store;
      this.log = log;
      this.changed = changed;
      this.pageUrl = pageUrl;
    }
    store;
    log;
    changed;
    pageUrl;
    batches = /* @__PURE__ */ new Map();
    quarantines = /* @__PURE__ */ new Map();
    unsavedQuarantines = /* @__PURE__ */ new Map();
    // Directory identity always includes all parent codes.
    catalog = /* @__PURE__ */ new Map();
    directorySequence = /* @__PURE__ */ new Map();
    active = null;
    fatal = null;
    seq = 0;
    transition = false;
    queue = Promise.resolve();
    session = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    serial(work) {
      const next = this.queue.then(work);
      this.queue = next.catch((e) => {
        this.fatal = String(e);
        this.log(`\u5B58\u50A8\u6216\u5904\u7406\u5931\u8D25\uFF0C\u505C\u6B62\u81EA\u52A8\u904D\u5386\uFF1A${this.fatal}`);
        this.changed();
      });
      return this.queue;
    }
    async restore() {
      await this.serial(async () => {
        for (const b of await this.store.all("batches")) {
          if (Object.keys(b.requests).length) b.timedOut = true;
          b.requests = {};
          if (Object.values(b.files).some((f) => !f.exported)) {
            this.batches.set(b.key, b);
          } else {
            for (const f of Object.values(b.files)) delete f.text;
            this.batches.set(b.key, b);
          }
        }
        for (const q of await this.store.all("quarantine")) {
          const { response: _, ...meta } = q;
          this.quarantines.set(q.id, meta);
        }
        this.changed();
      });
    }
    begin(c, force = false) {
      const path = pathOf(c);
      if (!full(path) || this.transition || this.fatal) return;
      const old = this.active ? this.batches.get(this.active) : void 0;
      if (!force && old && same(old.path, path)) return old;
      const round = `${this.session}-${++this.seq}`;
      const key = JSON.stringify([...path, round]);
      const b = { key, path, nodeId: path[3], ctx: structuredClone(c), round, createdAt: Date.now(), updatedAt: Date.now(), files: {}, requests: {}, checked: false, pageUrl: this.pageUrl };
      this.batches.set(key, b);
      this.active = key;
      void this.serial(async () => {
        await this.store.put("batches", b);
        this.changed();
      });
      return b;
    }
    reserve() {
      return { seq: ++this.seq, round: this.active, transition: this.transition };
    }
    start(url, body, c, started = Date.now(), dispatch = this.reserve()) {
      const query = Object.fromEntries(new URL(url, "https://sellercentral.amazon.com").searchParams);
      const e = merge(evidence(query), evidence(parseBody(body)));
      const t = { id: `${this.session}-req-${dispatch.seq}`, seq: dispatch.seq, started, endpoint: endpoint(url), evidence: e, context: structuredClone(c), round: null };
      if (t.endpoint === "getFilters") return t;
      if (conflict(e) || e.node.length !== 1) t.error = "\u8BF7\u6C42\u65E0\u552F\u4E00\u3001\u6709\u6548\u7684\u8282\u70B9\u51ED\u636E";
      if (dispatch.round !== this.active || dispatch.transition !== this.transition) t.error = "\u8BF7\u6C42\u6B63\u6587\u5F02\u6B65\u89E3\u6790\u671F\u95F4\u4E0A\u4E0B\u6587\u6539\u53D8";
      const p = pathOf(c);
      const requested = [e.market[0] || p[0], e.category[0] || p[1], e.product[0] || p[2], e.node[0] || ""];
      if (!t.error && !full(requested)) t.error = "\u8BF7\u6C42\u7F3A\u5C11\u53EF\u6838\u5BF9\u7684\u5B8C\u6574\u7236\u7EA7\u8DEF\u5F84";
      const explicit = e.market.length === 1 && e.category.length === 1 && e.product.length === 1;
      if (!t.error && (!explicit && (this.transition || !same(requested, p)))) t.error = "\u8BF7\u6C42\u4E0E\u53D1\u8D77\u65F6\u9875\u9762\u8DEF\u5F84\u4E0D\u4E00\u81F4";
      const list = this.catalog.get(JSON.stringify(requested.slice(0, 3)));
      if (!t.error && list && !list.has(requested[3])) t.error = "\u8BF7\u6C42\u8282\u70B9\u4E0D\u5C5E\u4E8E\u7236\u7EA7\u76EE\u5F55";
      if (!t.error && !explicit && !list) t.error = "\u7236\u7EA7\u76EE\u5F55\u5C1A\u672A\u9A8C\u8BC1\uFF0C\u65E0\u6CD5\u8865\u5168\u8BF7\u6C42\u8DEF\u5F84";
      if (!t.error) {
        const ctx = same(requested, p) ? c : {
          store: { value: requested[0], label: requested[0] },
          category: { value: requested[1], label: requested[1] },
          product_type: { value: requested[2], label: requested[2] },
          keyword: { value: requested[3], label: list?.get(requested[3]) || requested[3] },
          nodeId: requested[3]
        };
        let b = [...this.batches.values()].reverse().find((x2) => same(x2.path, requested) && x2.key === this.active);
        if (!b) {
          if (same(requested, p) && !this.transition) b = this.begin(ctx);
          else t.error = "\u8BF7\u6C42\u5C5E\u4E8E\u975E\u5F53\u524D\u8DEF\u5F84\u4E14\u65E0\u5DF2\u7ED1\u5B9A\u91C7\u96C6\u8F6E\u6B21";
        }
        if (b) {
          t.round = b.key;
          t.context = structuredClone(b.ctx);
          b.requests[t.id] = started;
          void this.serial(async () => this.store.put("batches", await this.withStoredText(b)));
        }
      }
      this.log(`\u8BF7\u6C42 ${t.id}\uFF5C${t.endpoint}\uFF5C${JSON.stringify(requested)}${t.error ? `\uFF5C\u5F85\u9694\u79BB\uFF1A${t.error}` : ""}`);
      return t;
    }
    directory(t, json) {
      const body = t.evidence;
      if (!object(json) || json.type !== "MP_CAT_PTD_BN" || !Array.isArray(json.filterDataPoints) || conflict(body)) return;
      const parent = [body.market[0], body.category[0], body.product[0]];
      if (!parent.every(Boolean)) return;
      if ((this.directorySequence.get(JSON.stringify(parent)) || 0) > t.seq) return;
      const pairs = [];
      for (const x2 of json.filterDataPoints) {
        if (!object(x2) || scalar(x2.value) === void 0 || typeof x2.label !== "string") return;
        pairs.push([scalar(x2.value), x2.label]);
      }
      if (json.hasMore === true || json.nextToken || json.nextPageToken || Number(json.totalCount) > pairs.length) return;
      this.catalog.set(JSON.stringify(parent), new Map(pairs));
      this.directorySequence.set(JSON.stringify(parent), t.seq);
      this.log(`\u5DF2\u9A8C\u8BC1\u5173\u952E\u8BCD\u76EE\u5F55 ${JSON.stringify(parent)}\uFF5C${pairs.length}\u9879`);
    }
    finish(t, status, raw) {
      return this.serial(async () => {
        const b = t.round ? this.batches.get(t.round) : void 0;
        if (b) delete b.requests[t.id];
        let json;
        try {
          json = JSON.parse(raw);
        } catch {
          json = null;
        }
        if (t.endpoint === "getFilters") {
          if (status >= 200 && status < 300) this.directory(t, json);
          return;
        }
        let reason = t.error || (status < 200 || status >= 300 ? `HTTP ${status}` : "") || (!object(json) ? "\u54CD\u5E94\u4E0D\u662F JSON \u5BF9\u8C61" : "");
        const responseEvidence = merge(evidence(json), metricEvidence(json, t.context));
        if (!reason && conflict(responseEvidence)) reason = "\u54CD\u5E94\u5305\u542B\u51B2\u7A81\u6216\u4E0D\u5B89\u5168\u7684\u6807\u8BC6";
        if (!reason && b) {
          for (const [i2, key] of ["market", "category", "product", "node"].entries()) {
            if (responseEvidence[key].length && responseEvidence[key][0] !== b.path[i2]) reason = "\u8BF7\u6C42\u4E0E\u54CD\u5E94\u6807\u8BC6\u51B2\u7A81";
          }
        }
        let kind;
        if (t.endpoint === "getPerformanceDashboard") kind = "getPerformanceDashboard";
        if (t.endpoint === "getFeaturesDashboard") kind = "getFeaturesDashboard";
        if (t.endpoint === "relatedAsinDashboard") {
          const variants = new Set([...t.evidence.variant, ...responseEvidence.variant].filter((x2) => ["top_grossing", "new_successful"].includes(x2)));
          if (variants.size === 1) kind = `relatedAsin_${[...variants][0]}`;
          else reason ||= "\u5173\u8054 ASIN \u7C7B\u578B\u4E0D\u660E\u786E\u6216\u51B2\u7A81";
        }
        if (!reason && object(json)) {
          if (kind === "getFeaturesDashboard" && !Array.isArray(json.featuresList)) reason = "\u7279\u5F81\u54CD\u5E94\u7ED3\u6784\u65E0\u6548";
          if (kind?.startsWith("relatedAsin_") && !Array.isArray(json.relatedASINs) && !Array.isArray(json.asinList)) reason = "ASIN \u54CD\u5E94\u7ED3\u6784\u65E0\u6548";
          if (kind === "getPerformanceDashboard" && !object(json.demand) && !Array.isArray(json.demand) && !object(json.competition) && !Array.isArray(json.competition) && !Array.isArray(json.relatedASINs)) reason = "\u8868\u73B0\u54CD\u5E94\u7ED3\u6784\u65E0\u6548";
        }
        if (!b || !kind) reason ||= "\u6CA1\u6709\u5DF2\u7ED1\u5B9A\u7684\u91C7\u96C6\u8F6E\u6B21\u6216\u54CD\u5E94\u7C7B\u578B";
        if (reason) {
          const q = { id: t.id, reason, request: t, status, response: raw, createdAt: Date.now() };
          const { response: _, ...meta } = q;
          this.quarantines.set(q.id, meta);
          this.unsavedQuarantines.set(q.id, q);
          await this.store.put("quarantine", q);
          this.unsavedQuarantines.delete(q.id);
          this.log(`\u9694\u79BB ${t.id}\uFF5C${reason}`);
        } else if (b && kind) {
          const prior = b.files[kind];
          if (!prior || prior.seq < t.seq) {
            if (b.exportId) b.supplementOf ||= b.exportId;
            b.files[kind] = { requestId: t.id, seq: t.seq, name: `${b.nodeId}\u4E28${kind}\u4E28${new Date(t.started).toISOString().replace(/[:.]/g, "-")}.json`, text: raw, exported: false };
            b.updatedAt = Date.now();
            this.log(`\u5DF2\u5F52\u5165 ${b.nodeId}\uFF5C${kind}${b.supplementOf ? "\uFF5C\u8865\u5145\u5305\u5F85\u5BFC\u51FA" : ""}`);
          } else this.log(`\u5FFD\u7565\u65E7\u8BF7\u6C42\u8986\u76D6 ${t.id}`);
        }
        if (b) await this.store.put("batches", await this.withStoredText(b));
        this.changed();
      });
    }
    async withStoredText(b) {
      const copy = structuredClone(b);
      if (Object.values(copy.files).some((f) => f.text === void 0)) {
        const old = await this.store.get("batches", b.key);
        for (const kind of TYPES) {
          const f = copy.files[kind], prev = old?.files[kind];
          if (f && f.text === void 0 && prev?.requestId === f.requestId) f.text = prev.text;
        }
      }
      return copy;
    }
    async snapshots(keys, pendingOnly = true) {
      await this.queue;
      return Promise.all(keys.map(async (key) => {
        const b = this.batches.get(key);
        if (!b) throw new Error("\u6279\u6B21\u5DF2\u4E0D\u5B58\u5728");
        const result = await this.withStoredText(b);
        result.availableTypes = TYPES.filter((t) => !!result.files[t]);
        if (pendingOnly) {
          for (const type of TYPES) if (result.files[type]?.exported) delete result.files[type];
        }
        return result;
      }));
    }
    async markExported(snapshots, exportId) {
      return this.serial(async () => {
        for (const snap of snapshots) {
          const b = this.batches.get(snap.key);
          if (!b) continue;
          b.exportId ||= exportId;
          for (const type of TYPES) {
            const f = b.files[type];
            if (f && f.requestId === snap.files[type]?.requestId) f.exported = true;
          }
          if (Object.values(b.files).some((f) => !f.exported)) b.supplementOf ||= b.exportId;
          await this.store.put("batches", await this.withStoredText(b));
          for (const f of Object.values(b.files)) if (f.exported) delete f.text;
        }
        this.changed();
      });
    }
    complete(key) {
      const b = this.batches.get(key);
      return !!b && TYPES.every((t) => b.files[t]) && !Object.keys(b.requests).length;
    }
  };

  // 仓库/tools.aioz.cc/node_modules/fflate/esm/browser.js
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
  var freb = function(eb, start) {
    var b = new u16(31);
    for (var i2 = 0; i2 < 31; ++i2) {
      b[i2] = start += 1 << eb[i2 - 1];
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

  // Capture module: ui.js
  (function() {
    "use strict";
    const TARGET_KEYS = [
      "/next/v2/getPerformanceDashboard",
      "/next/v2/getFeaturesDashboard",
      "/next/v2/relatedAsinDashboard"
    ];
    const SEP = "\u4E28";
    const F = {
      // 页面四级筛选器
      store: "sgar-tmp-filter",
      category: "sgar-cat-filter",
      ptype: "sgar-pdt-filter",
      keyword: "sgar-bn-filter"
    };
    const TYPE_LABELS = [
      { key: "getPerformanceDashboard", label: "\u6240\u6709ASIN" },
      { key: "relatedAsin_top_grossing", label: "\u6700\u7545\u9500ASIN" },
      { key: "relatedAsin_new_successful", label: "\u65B0\u53D1\u5E03ASIN" },
      { key: "getFeaturesDashboard", label: "\u4EA7\u54C1\u7279\u5F81\u8D8B\u52BF" }
    ];
    const batches = {};
    const processedNodeIds = /* @__PURE__ */ new Set();
    function toUrlString(url) {
      if (!url) return "";
      if (typeof url === "string") return url;
      if (url instanceof URL) return url.href;
      if (typeof url === "object" && url.url) return url.url;
      return String(url);
    }
    function isTargetUrl(url) {
      const s = toUrlString(url);
      return TARGET_KEYS.some((k) => s.includes(k));
    }
    function sleep(ms) {
      return new Promise((r) => setTimeout(r, ms));
    }
    async function interruptibleSleep(ms, checkStop = true) {
      const step = 200;
      let elapsed = 0;
      while (elapsed < ms) {
        if (checkStop && (AUTO.stopping || !AUTO.running)) break;
        const cur = Math.min(step, ms - elapsed);
        await sleep(cur);
        elapsed += cur;
      }
    }
    function safeSaveAs(blob, filename) {
      try {
        if (typeof saveAs === "function") {
          saveAs(blob, filename);
          return;
        }
        if (window.saveAs && typeof window.saveAs === "function") {
          window.saveAs(blob, filename);
          return;
        }
      } catch (e) {
        console.warn("[Tampermonkey] saveAs \u5F02\u5E38\uFF0C\u4F7F\u7528 a[download] \u56DE\u9000", e);
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 1500);
    }
    function stamp() {
      return (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
    }
    function formatBytes(b) {
      if (!b) return "0 B";
      if (b < 1024) return b + " B";
      if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
      return (b / 1048576).toFixed(2) + " MB";
    }
    const logs = [];
    let logBox = null;
    function addLog(level, msg) {
      const t = /* @__PURE__ */ new Date();
      const ts = t.toLocaleTimeString("zh-CN", { hour12: false }) + "." + String(t.getMilliseconds()).padStart(3, "0");
      logs.push({ ts, level, msg, full: t.toISOString() });
      if (logs.length > 3e3) logs.shift();
      if (logBox) {
        const atBottom = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 30;
        const d = document.createElement("div");
        d.textContent = `[${ts}] ${msg}`;
        d.style.color = level === "E" ? "#ff8a80" : level === "W" ? "#ffd54f" : "#c8e6c9";
        d.style.whiteSpace = "pre-wrap";
        d.style.wordBreak = "break-all";
        logBox.appendChild(d);
        while (logBox.childNodes.length > 800) logBox.removeChild(logBox.firstChild);
        if (atBottom) logBox.scrollTop = logBox.scrollHeight;
      }
    }
    const logI = (m) => addLog("I", m);
    const logW = (m) => addLog("W", "\u26A0 " + m);
    const logE = (m) => addLog("E", "\u2716 " + m);
    function downloadLog() {
      if (!logs.length) {
        alert("\u6682\u65E0\u65E5\u5FD7");
        return;
      }
      const head = `\u4E9A\u9A6C\u900A\u7C7B\u76EE\u6570\u636E\u6293\u53D6\u65E5\u5FD7
\u5BFC\u51FA\u65F6\u95F4\uFF1A${(/* @__PURE__ */ new Date()).toLocaleString("zh-CN")}
\u9875\u9762\uFF1A${location.href}
\u5171 ${logs.length} \u6761
${"=".repeat(60)}
`;
      const body = logs.map((l) => `[${l.full}] [${l.level}] ${l.msg}`).join("\n");
      safeSaveAs(
        new Blob([head + body], { type: "text/plain;charset=utf-8" }),
        `\u7C7B\u76EE\u6570\u636E\u6293\u53D6_${stamp()}.log`
      );
      logI("\u65E5\u5FD7\u5DF2\u5BFC\u51FA");
    }
    function readFilter(name) {
      const nodes = Array.from(document.querySelectorAll(`kat-radiobutton[name="${name}"]`));
      let index = -1;
      nodes.forEach((el2, i2) => {
        const c = el2.getAttribute("checked");
        const isChecked = el2.checked === true || c !== null && c !== "false" || el2.getAttribute("aria-checked") === "true";
        if (isChecked) index = i2;
      });
      const el = index >= 0 ? nodes[index] : null;
      return {
        nodes,
        index,
        el,
        total: nodes.length,
        label: el ? el.getAttribute("label") : null,
        value: el ? el.getAttribute("value") : null
      };
    }
    function normText(s) {
      if (s === null || s === void 0) return "";
      return String(s).replace(/\s+/g, " ").trim();
    }
    function one(f) {
      return {
        label: normText(f.label),
        value: normText(f.value),
        index: f.index >= 0 ? f.index + 1 : 0,
        total: f.total
      };
    }
    function readContext() {
      const s = readFilter(F.store), c = readFilter(F.category);
      const p = readFilter(F.ptype), k = readFilter(F.keyword);
      return {
        store: one(s),
        category: one(c),
        product_type: one(p),
        keyword: one(k),
        nodeId: k.value || null
      };
    }
    const DB_NAME = "amz_category_insights_capture_v1";
    const dbReady = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("batches", { keyPath: "key" });
        request.result.createObjectStore("quarantine", { keyPath: "id" });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("\u6570\u636E\u5E93\u5347\u7EA7\u88AB\u5176\u4ED6\u6807\u7B7E\u9875\u963B\u585E"));
    });
    const storage = {
      async put(table, value) {
        const db = await dbReady;
        return new Promise((resolve, reject) => {
          const tx = db.transaction(table, "readwrite");
          tx.objectStore(table).put(structuredClone(value));
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error || new Error("\u4E8B\u52A1\u4E2D\u6B62"));
        });
      },
      async all(table) {
        const db = await dbReady;
        return new Promise((resolve, reject) => {
          const r = db.transaction(table).objectStore(table).getAll();
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
      },
      async get(table, key) {
        const db = await dbReady;
        return new Promise((resolve, reject) => {
          const r = db.transaction(table).objectStore(table).get(key);
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
      }
    };
    const engine = new CaptureEngine(storage, (m) => logI(m), refreshViews, location.href);
    const restored = engine.restore();
    function refreshViews() {
      for (const key of Object.keys(batches)) delete batches[key];
      for (const [key, b] of engine.batches) {
        if (processedNodeIds.has(key)) continue;
        const pending = Object.values(b.files).some((f) => !f.exported);
        if (!pending && Object.keys(b.files).length && !Object.keys(b.requests).length) continue;
        batches[key] = { ...b, files: Object.fromEntries(Object.entries(b.files).map(([type, f]) => [type, { ...f, blob: new Blob([f.text || ""], { type: "application/json" }) }])) };
      }
      if (typeof AUTO !== "undefined") {
        if (engine.fatal) AUTO.stopping = true;
        if (AUTO.running && AUTO.seen) {
          for (const b of engine.batches.values()) if (Object.keys(b.files).length && b.createdAt >= AUTO.runStarted) AUTO.seen.add(b.key);
          AUTO.totalCaptured = AUTO.seen.size;
        }
      }
      refreshList();
    }
    function buildNodeMeta(b) {
      const c = b.ctx;
      return {
        schema_version: 1,
        script_version: VERSION,
        node_id: b.nodeId,
        captured_at: new Date(b.createdAt).toISOString(),
        updated_at: new Date(b.updatedAt).toISOString(),
        page_url: b.pageUrl,
        store: c.store,
        category: c.category,
        product_type: c.product_type,
        keyword: c.keyword,
        file_count: Object.keys(b.files).length,
        response_types: Object.keys(b.files),
        response_files: Object.values(b.files).map((f) => f.name),
        capture_batch_id: b.key,
        capture_round: b.round,
        path_codes: b.path,
        export_batch_id: b.exportId || null,
        supplement_of: b.supplementOf || null,
        missing_types: TYPES.filter((type) => !(b.availableTypes || Object.keys(b.files)).includes(type)),
        timed_out: !!b.timedOut,
        request_evidence: Object.fromEntries(Object.entries(b.files).map(([type, f]) => [type, { request_id: f.requestId, request_sequence: f.seq }]))
      };
    }
    async function saveZip(entries, name) {
      const bytes = zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strToU8(v)])), { level: 6 });
      safeSaveAs(new Blob([bytes], { type: "application/zip" }), name);
      logI(`\u5DF2\u89E6\u53D1\u4E0B\u8F7D ${name}\uFF08${formatBytes(bytes.length)}\uFF09\uFF1B\u8BF7\u68C0\u67E5\u6D4F\u89C8\u5668\u4E0B\u8F7D\u8BB0\u5F55`);
    }
    let presetRoundClick = false;
    function clickBoundKeyword(el) {
      presetRoundClick = true;
      try {
        el?.click();
      } finally {
        presetRoundClick = false;
      }
    }
    let downloadBusy = false;
    async function downloadBatches(list, tag, pendingOnly = true) {
      if (downloadBusy) {
        logW("\u5DF2\u6709\u6253\u5305\u4EFB\u52A1\uFF0C\u8BF7\u7B49\u5F85\u5B8C\u6210");
        return false;
      }
      downloadBusy = true;
      try {
        await restored;
        const keys = list.map((b) => b.key);
        const snapshots = await engine.snapshots(keys, pendingOnly);
        const groups = [];
        for (const b of snapshots) {
          if (!Object.keys(b.files).length && !b.timedOut) continue;
          let group = groups.find((g) => !g.some((x2) => x2.nodeId === b.nodeId));
          if (!group) {
            group = [];
            groups.push(group);
          }
          group.push(b);
        }
        if (!groups.length) {
          logW("\u6CA1\u6709\u5F85\u5BFC\u51FA\u7684\u6570\u636E");
          return false;
        }
        for (const group of groups) {
          const exportId = `${engine.session}-export-${++engine.seq}`;
          const entries = {};
          for (const b of group) {
            const dir = `${b.nodeId}_${Object.keys(b.files).length}`;
            for (const f of Object.values(b.files)) {
              if (f.text === void 0) throw new Error("\u672C\u5730\u6B63\u6587\u7F3A\u5931\uFF0C\u505C\u6B62\u5BFC\u51FA");
              entries[`${dir}/${f.name}`] = f.text;
            }
            entries[`${dir}/NODE\u4E28${b.nodeId}\u4E28${stamp()}.json`] = JSON.stringify({ ...buildNodeMeta(b), export_batch_id: exportId }, null, 2);
          }
          entries["\u91C7\u96C6\u62A5\u544A.json"] = JSON.stringify({ script_version: VERSION, export_batch_id: exportId, tag, download_status: "triggered", nodes: group.map((b) => buildNodeMeta(b)) }, null, 2);
          const supplement = group.some((b) => b.supplementOf) ? "\u8865\u5145" : "\u6279\u91CF";
          await saveZip(entries, `AMZ\u4E28\u7C7B\u76EE\u5206\u6790\u6570\u636E\u6293\u53D6\u4E28${supplement}\u4E28${group.length}\u4E28${stamp()}\u4E28${engine.seq}.zip`);
          if (pendingOnly) await engine.markExported(group, exportId);
        }
        if (engine.fatal) throw new Error(engine.fatal);
        refreshViews();
        return true;
      } catch (e) {
        logE(`\u6253\u5305\u6216\u4FDD\u5B58\u6807\u8BB0\u5931\u8D25\uFF1A${e.message}\uFF1B\u6570\u636E\u4FDD\u7559`);
        return false;
      } finally {
        downloadBusy = false;
      }
    }
    function clearAll() {
      for (const key of Object.keys(batches)) processedNodeIds.add(key);
      refreshViews();
      logI("\u5DF2\u9690\u85CF\u5217\u8868\uFF0C\u672C\u5730\u6570\u636E\u4ECD\u53EF\u5386\u53F2\u8865\u4E0B\u8F7D");
    }
    async function downloadAllAndClear(tag) {
      return downloadBatches(Object.values(batches), tag);
    }
    async function downloadSingle(key) {
      return downloadBatches([engine.batches.get(key)], "\u5355\u8282\u70B9");
    }
    async function exportQuarantine() {
      await engine.queue;
      const entries = {};
      let saved = [];
      try {
        saved = await storage.all("quarantine");
      } catch (e) {
        logW(`\u5B58\u50A8\u4E0D\u53EF\u7528\uFF0C\u5BFC\u51FA\u5185\u5B58\u4E2D\u7684\u9694\u79BB\u54CD\u5E94\uFF1A${e.message}`);
      }
      const records = new Map(saved.map((q) => [q.id, q]));
      for (const [id, q] of engine.unsavedQuarantines) records.set(id, q);
      for (const q of records.values()) {
        const { response, ...metadata } = q;
        entries[`${q.id}/response.txt`] = response;
        entries[`${q.id}/\u5F52\u5C5E\u8BC1\u636E.json`] = JSON.stringify(metadata, null, 2);
      }
      if (!Object.keys(entries).length) {
        logW("\u6682\u65E0\u9694\u79BB\u54CD\u5E94");
        return;
      }
      await saveZip(entries, `AMZ\u4E28\u5F85\u6838\u9A8C\u54CD\u5E94\u4E28${stamp()}.zip`);
    }
    const AUTO = {
      running: false,
      stopping: false,
      target: 50,
      // 每批下载的节点数
      totalLimit: 0,
      // 本次总抓取上限，0 = 不限制
      delayMin: 5,
      // 随机延迟下限（秒），最低 3
      delayMax: 35,
      // 随机延迟上限（秒），最低 3
      levels: { keyword: true, ptype: false, category: false, store: false },
      totalCaptured: 0
    };
    const DELAY_FLOOR = 3;
    const LEVEL_ORDER = ["keyword", "ptype", "category", "store"];
    function normalizeLevels(changed) {
      AUTO.levels.keyword = true;
      const i2 = LEVEL_ORDER.indexOf(changed);
      if (AUTO.levels[changed]) {
        for (let k = 0; k < i2; k++) AUTO.levels[LEVEL_ORDER[k]] = true;
      } else {
        for (let k = i2 + 1; k < LEVEL_ORDER.length; k++) AUTO.levels[LEVEL_ORDER[k]] = false;
      }
      syncLevelUI();
    }
    function waitKeywordRebuilt(expectedLevel, expectedValue, since, timeout = 25e3) {
      return new Promise((res) => {
        const t0 = Date.now();
        let autoClicked = false;
        const iv = setInterval(() => {
          const kw = readFilter(F.keyword);
          const ctx = readContext(), parent = JSON.stringify(pathOf(ctx).slice(0, 3));
          const matched = readFilter(F[expectedLevel]).value === expectedValue;
          const fresh = (engine.directorySequence.get(parent) || 0) > since;
          if (matched && fresh && engine.catalog.get(parent)?.has(kw.value)) {
            clearInterval(iv);
            res(kw.value);
            return;
          }
          if (kw.total > 0 && kw.index === -1 && !autoClicked && Date.now() - t0 > 1500) {
            autoClicked = true;
            logI("\u5173\u952E\u8BCD\u5217\u8868\u5DF2\u6E32\u67D3\uFF0C\u4E3B\u52A8\u6FC0\u6D3B\u9996\u9879");
            kw.nodes[0].click();
          }
          if (Date.now() - t0 > timeout) {
            clearInterval(iv);
            res(null);
          }
        }, 300);
      });
    }
    async function waitForPerf(key, timeout = 6e4) {
      const started = Date.now();
      while (AUTO.running && !AUTO.stopping && !engine.fatal) {
        await engine.queue;
        if (engine.complete(key)) return true;
        if (Date.now() - started >= timeout) {
          const batch = engine.batches.get(key);
          if (batch) {
            batch.timedOut = true;
            await engine.store.put("batches", await engine.snapshots([key], false).then((x2) => x2[0]));
          }
          logW(`\u7B49\u5F8560\u79D2\u8D85\u65F6\uFF0C\u4FDD\u7559\u7F3A\u5931\u62A5\u544A\u5E76\u7EE7\u7EED\uFF1A${key}`);
          refreshViews();
          return false;
        }
        await sleep(200);
      }
      return false;
    }
    async function advance() {
      const kw = readFilter(F.keyword);
      if (kw.index >= 0 && kw.index < kw.total - 1) {
        const el = kw.nodes[kw.index + 1];
        const id = el.getAttribute("value");
        logI(`\u5207\u6362\u5173\u952E\u8BCD [${kw.index + 2}/${kw.total}] \u2192 ${el.getAttribute("label")}\uFF08${id}\uFF09`);
        engine.transition = false;
        const nextContext = readContext();
        nextContext.keyword = { label: normText(el.getAttribute("label")), value: id, index: kw.index + 2, total: kw.total };
        nextContext.nodeId = id;
        engine.begin(nextContext, true);
        clickBoundKeyword(el);
        await sleep(400);
        return { nodeId: id, key: engine.active };
      }
      for (const lv of ["ptype", "category", "store"]) {
        if (!AUTO.levels[lv]) break;
        const f = readFilter(F[lv]);
        if (f.index < f.total - 1) {
          const el = f.nodes[f.index + 1];
          const cn = { ptype: "\u5546\u54C1\u7C7B\u578B", category: "\u7C7B\u522B", store: "\u5546\u5E97" }[lv];
          logI(`\u5173\u952E\u8BCD\u5DF2\u6293\u5B8C\uFF0C\u5207\u6362${cn} [${f.index + 2}/${f.total}] \u2192 ${el.getAttribute("label")}`);
          const since = engine.seq;
          beginTransition(lv, el.getAttribute("value"));
          el.click();
          const id = await waitKeywordRebuilt(lv, el.getAttribute("value"), since);
          if (!id) {
            logE(`\u5207\u6362${cn}\u540E\u5173\u952E\u8BCD\u5217\u8868\u672A\u91CD\u5EFA\uFF08\u8D85\u65F6\uFF09`);
            engine.transition = false;
            return null;
          }
          await sleep(300);
          engine.transition = false;
          const bound = engine.begin(readContext());
          logI(`  \u65B0\u5217\u8868\u9996\u4E2A\u5173\u952E\u8BCD\u5DF2\u9009\u4E2D\uFF1A${readFilter(F.keyword).label}\uFF08${id}\uFF09`);
          return { nodeId: id, key: bound?.key };
        }
        logI(`${{ ptype: "\u5546\u54C1\u7C7B\u578B", category: "\u7C7B\u522B", store: "\u5546\u5E97" }[lv]}\u5DF2\u5168\u90E8\u6293\u5B8C`);
      }
      return null;
    }
    async function autoRun() {
      if (engine.fatal) {
        logE(engine.fatal);
        return;
      }
      AUTO.running = true;
      AUTO.stopping = false;
      AUTO.seen = new Set(Object.keys(batches));
      AUTO.runStarted = Date.now();
      AUTO.totalCaptured = AUTO.seen.size;
      syncAutoUI();
      const lv = LEVEL_ORDER.filter((k) => AUTO.levels[k]).map((k) => ({ keyword: "\u5173\u952E\u8BCD", ptype: "\u5546\u54C1\u7C7B\u578B", category: "\u7C7B\u522B", store: "\u5546\u5E97" })[k]);
      logI(`===== \u81EA\u52A8\u6293\u53D6\u5F00\u59CB =====`);
      logI(`\u5C42\u7EA7\uFF1A${lv.join(" \u2192 ")}\uFF5C\u6BCF\u6279 ${AUTO.target} \u4E2A\uFF5C\u603B\u91CF ${AUTO.totalLimit || "\u4E0D\u9650"}\uFF5C\u5EF6\u8FDF ${AUTO.delayMin}~${AUTO.delayMax} \u79D2`);
      const initial = engine.begin(readContext());
      if (initial) {
        logI(`\u5148\u7B49\u5F85\u5F53\u524D\u8282\u70B9 ${initial.nodeId}`);
        await waitForPerf(initial.key);
      }
      try {
        while (AUTO.running && !AUTO.stopping) {
          const next = await advance();
          if (!next) {
            logI("\u6240\u6709\u76EE\u6807\u5DF2\u6293\u53D6\u5B8C\u6BD5");
            break;
          }
          const ok = await waitForPerf(next.key);
          if (engine.fatal) break;
          if (AUTO.stopping) break;
          if (ok) {
            logI(`  \u8282\u70B9 ${next.nodeId} \u56DB\u7C7B\u6570\u636E\u5DF2\u9F50\u5168`);
          } else {
            logW(`\u8282\u70B9 ${next.nodeId} \u7B49\u5F85\u7ED3\u675F\u4ECD\u7F3A\u6570\u636E\uFF08\u4E0D\u8BA1\u4E3A\u5B8C\u6574\uFF09\uFF0C\u7EE7\u7EED\u4E0B\u4E00\u4E2A`);
          }
          if (AUTO.stopping) break;
          const lo = AUTO.delayMin * 1e3, hi = AUTO.delayMax * 1e3;
          const d = lo + Math.random() * Math.max(0, hi - lo);
          logI(`  \u968F\u673A\u5EF6\u8FDF ${(d / 1e3).toFixed(1)} \u79D2\uFF08\u671F\u95F4\u4ECD\u4F1A\u63A5\u6536\u843D\u540E\u54CD\u5E94\uFF09`);
          updateProgress();
          await interruptibleSleep(d, true);
          const n = Object.keys(batches).length;
          if (n >= AUTO.target) {
            logI(`\u5DF2\u7D2F\u8BA1 ${n} \u4E2A\u8282\u70B9\uFF0C\u8FBE\u5230\u6BCF\u6279\u9608\u503C\uFF0C\u5148\u4E0B\u8F7D\u5E76\u6E05\u7A7A\u518D\u7EE7\u7EED`);
            await downloadAllAndClear("\u6279\u91CF");
          }
          if (AUTO.totalLimit > 0 && AUTO.totalCaptured >= AUTO.totalLimit) {
            logI(`\u5DF2\u8FBE\u5230\u672C\u6B21\u603B\u91CF\u4E0A\u9650 ${AUTO.totalLimit} \u4E2A\u8282\u70B9\uFF0C\u505C\u6B62\u6293\u53D6`);
            break;
          }
          if (AUTO.stopping) {
            logI("\u6536\u5230\u7EC8\u6B62\u6307\u4EE4\uFF0C\u5DF2\u5B8C\u6210\u5F53\u524D\u8282\u70B9");
            break;
          }
        }
      } catch (e) {
        logE("\u81EA\u52A8\u6293\u53D6\u5F02\u5E38\uFF1A" + (e && e.message));
      }
      if (Object.keys(batches).length) {
        logI("\u4E0B\u8F7D\u6700\u540E\u4E00\u6279\u672A\u4E0B\u8F7D\u7684\u8282\u70B9");
        await downloadAllAndClear("\u6536\u5C3E");
      }
      engine.transition = false;
      AUTO.running = false;
      AUTO.stopping = false;
      logI(`===== \u81EA\u52A8\u6293\u53D6\u7ED3\u675F\uFF5C\u672C\u6B21\u5171\u6293\u53D6 ${AUTO.totalCaptured} \u4E2A\u8282\u70B9 =====`);
      syncAutoUI();
      updateProgress();
    }
    function stopAuto() {
      if (!AUTO.running) return;
      AUTO.stopping = true;
      logI("\u5DF2\u8BF7\u6C42\u7EC8\u6B62\uFF1A\u6B63\u5728\u5FEB\u901F\u6536\u5C3E\u5E76\u4E0B\u8F7D\u5269\u4F59\u6570\u636E\u2026");
      syncAutoUI();
    }
    let panel, listBox, statsEl, progEl, startBtn, stopBtn;
    let targetInput, totalInput, dMinInput, dMaxInput;
    const lvBoxes = {};
    function syncDelayUI() {
      if (dMinInput) dMinInput.value = String(AUTO.delayMin);
      if (dMaxInput) dMaxInput.value = String(AUTO.delayMax);
      logI(`\u968F\u673A\u5EF6\u8FDF\u8BBE\u4E3A ${AUTO.delayMin}~${AUTO.delayMax} \u79D2`);
    }
    function styleBtn(b, variant) {
      let bd = "#555", bg = "#333";
      if (variant === "primary") {
        bd = "#4caf50";
        bg = "#4caf50";
      } else if (variant === "danger") {
        bd = "#e53935";
        bg = "#c62828";
      } else if (variant === "warn") {
        bd = "#fb8c00";
        bg = "#ef6c00";
      }
      Object.assign(b.style, {
        fontSize: "12px",
        cursor: "pointer",
        borderRadius: "4px",
        border: "1px solid " + bd,
        padding: "2px 6px",
        background: bg,
        color: "#fff"
      });
    }
    function styleTag(t, on) {
      Object.assign(t.style, {
        fontSize: "11px",
        padding: "1px 4px",
        borderRadius: "4px",
        color: "#fff",
        background: on ? "#1e88e5" : "#555",
        border: "1px solid " + (on ? "#2196f3" : "#444"),
        whiteSpace: "nowrap"
      });
    }
    function createPanel() {
      if (panel) return;
      panel = document.createElement("div");
      Object.assign(panel.style, {
        position: "fixed",
        top: "10px",
        left: "10px",
        zIndex: "999999",
        background: "rgba(20,20,20,0.94)",
        color: "#fff",
        fontSize: "12px",
        padding: "8px",
        borderRadius: "6px",
        boxShadow: "0 4px 12px rgba(0,0,0,.6)",
        display: "flex",
        flexDirection: "column",
        minWidth: "430px",
        width: "450px",
        height: "560px",
        minHeight: "300px",
        maxHeight: "92vh",
        resize: "vertical",
        overflow: "hidden"
      });
      const header = document.createElement("div");
      Object.assign(header.style, {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "8px",
        fontWeight: "bold",
        marginBottom: "6px",
        cursor: "move",
        fontSize: "13px",
        flex: "0 0 auto"
      });
      const title = document.createElement("span");
      title.textContent = `Amazon \u7C7B\u76EE\u6D1E\u5BDF\u6570\u636E\u91C7\u96C6\u5668 v${VERSION}`;
      statsEl = document.createElement("span");
      Object.assign(statsEl.style, {
        fontWeight: "normal",
        fontSize: "11px",
        color: "#9ccc65",
        whiteSpace: "nowrap"
      });
      header.appendChild(title);
      header.appendChild(statsEl);
      const cfg = document.createElement("div");
      Object.assign(cfg.style, {
        flex: "0 0 auto",
        marginBottom: "6px",
        padding: "6px",
        background: "rgba(255,255,255,.06)",
        borderRadius: "4px"
      });
      const row1 = document.createElement("div");
      Object.assign(row1.style, {
        display: "flex",
        alignItems: "center",
        gap: "10px",
        flexWrap: "wrap",
        marginBottom: "5px"
      });
      const lab = document.createElement("span");
      lab.textContent = "\u81EA\u52A8\u5207\u6362\uFF1A";
      lab.style.color = "#bbb";
      row1.appendChild(lab);
      [["store", "\u5546\u5E97"], ["category", "\u7C7B\u522B"], ["ptype", "\u5546\u54C1\u7C7B\u578B"], ["keyword", "\u5173\u952E\u8BCD"]].forEach(([k, cn]) => {
        const w = document.createElement("label");
        Object.assign(w.style, {
          display: "flex",
          alignItems: "center",
          gap: "3px",
          cursor: "pointer",
          userSelect: "none"
        });
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = AUTO.levels[k];
        cb.style.margin = "0";
        cb.onchange = () => {
          AUTO.levels[k] = cb.checked;
          normalizeLevels(k);
        };
        lvBoxes[k] = cb;
        const s = document.createElement("span");
        s.textContent = cn;
        w.appendChild(cb);
        w.appendChild(s);
        row1.appendChild(w);
      });
      function mkNum(value, width, onCommit) {
        const i2 = document.createElement("input");
        i2.type = "number";
        i2.value = String(value);
        Object.assign(i2.style, {
          width: (width || 46) + "px",
          fontSize: "12px",
          padding: "1px 4px",
          borderRadius: "3px",
          border: "1px solid #555",
          background: "#222",
          color: "#fff"
        });
        i2.onchange = () => onCommit(parseInt(i2.value, 10), i2);
        return i2;
      }
      function mkLabel(text) {
        const s = document.createElement("span");
        s.textContent = text;
        s.style.color = "#bbb";
        return s;
      }
      const row2 = document.createElement("div");
      Object.assign(row2.style, {
        display: "flex",
        alignItems: "center",
        gap: "5px",
        flexWrap: "wrap",
        marginBottom: "5px"
      });
      targetInput = mkNum(AUTO.target, 46, (v) => {
        AUTO.target = v > 0 ? v : 50;
        targetInput.value = String(AUTO.target);
        logI(`\u6BCF\u6279\u4E0B\u8F7D\u6570\u91CF\u8BBE\u4E3A ${AUTO.target} \u4E2A\u8282\u70B9`);
      });
      totalInput = mkNum(AUTO.totalLimit, 46, (v) => {
        AUTO.totalLimit = Number.isFinite(v) && v > 0 ? v : 0;
        totalInput.value = String(AUTO.totalLimit);
        logI(AUTO.totalLimit ? `\u672C\u6B21\u603B\u91CF\u4E0A\u9650\u8BBE\u4E3A ${AUTO.totalLimit} \u4E2A\u8282\u70B9` : "\u672C\u6B21\u603B\u91CF\u5DF2\u8BBE\u4E3A\u4E0D\u9650\u5236");
      });
      dMinInput = mkNum(AUTO.delayMin, 40, (v) => {
        let x2 = Number.isFinite(v) ? v : AUTO.delayMin;
        if (x2 < DELAY_FLOOR) {
          x2 = DELAY_FLOOR;
          logW(`\u5EF6\u8FDF\u4E0B\u9650\u4E0D\u5F97\u4F4E\u4E8E ${DELAY_FLOOR} \u79D2\uFF0C\u5DF2\u4FEE\u6B63`);
        }
        AUTO.delayMin = x2;
        if (AUTO.delayMax < AUTO.delayMin) {
          AUTO.delayMax = AUTO.delayMin;
          logW(`\u5EF6\u8FDF\u4E0A\u9650\u5C0F\u4E8E\u4E0B\u9650\uFF0C\u5DF2\u540C\u6B65\u8C03\u6574\u4E3A ${AUTO.delayMax} \u79D2`);
        }
        syncDelayUI();
      });
      dMaxInput = mkNum(AUTO.delayMax, 40, (v) => {
        let x2 = Number.isFinite(v) ? v : AUTO.delayMax;
        if (x2 < DELAY_FLOOR) {
          x2 = DELAY_FLOOR;
          logW(`\u5EF6\u8FDF\u4E0A\u9650\u4E0D\u5F97\u4F4E\u4E8E ${DELAY_FLOOR} \u79D2\uFF0C\u5DF2\u4FEE\u6B63`);
        }
        if (x2 < AUTO.delayMin) {
          x2 = AUTO.delayMin;
          logW(`\u5EF6\u8FDF\u4E0A\u9650\u4E0D\u5F97\u5C0F\u4E8E\u4E0B\u9650\uFF0C\u5DF2\u4FEE\u6B63\u4E3A ${x2} \u79D2`);
        }
        AUTO.delayMax = x2;
        syncDelayUI();
      });
      row2.append(
        mkLabel("\u6BCF\u6279\u4E0B\u8F7D"),
        targetInput,
        mkLabel("\u4E2A\u8282\u70B9"),
        mkLabel("\u3000\u603B\u6570\u91CF"),
        totalInput,
        mkLabel("\u4E2A\u8282\u70B9\uFF080 = \u4E0D\u9650\u5236\uFF09")
      );
      const rowDelay = document.createElement("div");
      Object.assign(rowDelay.style, {
        display: "flex",
        alignItems: "center",
        gap: "5px",
        flexWrap: "wrap",
        marginBottom: "5px"
      });
      rowDelay.append(
        mkLabel("\u968F\u673A\u5EF6\u8FDF"),
        dMinInput,
        mkLabel("~"),
        dMaxInput,
        mkLabel(`\u79D2\uFF08\u6700\u4F4E ${DELAY_FLOOR} \u79D2\uFF09`)
      );
      const row3 = document.createElement("div");
      Object.assign(row3.style, { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" });
      startBtn = document.createElement("button");
      startBtn.textContent = "\u5F00\u59CB\u81EA\u52A8\u6293\u53D6";
      styleBtn(startBtn, "primary");
      startBtn.onclick = () => {
        if (!AUTO.running) autoRun();
      };
      stopBtn = document.createElement("button");
      stopBtn.textContent = "\u7EC8\u6B62\u81EA\u52A8\u6293\u53D6";
      styleBtn(stopBtn, "warn");
      stopBtn.onclick = stopAuto;
      row3.append(startBtn, stopBtn);
      progEl = document.createElement("div");
      Object.assign(progEl.style, { marginTop: "5px", fontSize: "11px", color: "#90caf9" });
      cfg.append(row1, row2, rowDelay, row3, progEl);
      const bar = document.createElement("div");
      Object.assign(bar.style, {
        marginBottom: "6px",
        display: "flex",
        gap: "4px",
        flexWrap: "wrap",
        flex: "0 0 auto"
      });
      const bAll = document.createElement("button");
      bAll.textContent = "\u5168\u9009";
      styleBtn(bAll);
      bAll.onclick = () => {
        Object.values(batches).forEach((b) => b.checked = true);
        refreshList();
      };
      const bInv = document.createElement("button");
      bInv.textContent = "\u53CD\u9009";
      styleBtn(bInv);
      bInv.onclick = () => {
        Object.values(batches).forEach((b) => b.checked = !b.checked);
        refreshList();
      };
      const bDl = document.createElement("button");
      bDl.textContent = "\u4E0B\u8F7D\u9009\u4E2D";
      styleBtn(bDl, "primary");
      bDl.onclick = async () => {
        const sel = Object.values(batches).filter((b) => b.checked);
        if (!sel.length) {
          alert("\u8BF7\u5148\u52FE\u9009\u81F3\u5C11\u4E00\u4E2A\u6279\u6B21");
          return;
        }
        await downloadBatches(sel, "\u624B\u52A8");
      };
      const bDel = document.createElement("button");
      bDel.textContent = "\u9690\u85CF\u9009\u4E2D";
      styleBtn(bDel, "danger");
      bDel.onclick = () => {
        const ids = Object.keys(batches).filter((id) => batches[id].checked);
        if (!ids.length) {
          alert("\u8BF7\u5148\u52FE\u9009\u81F3\u5C11\u4E00\u4E2A\u6279\u6B21");
          return;
        }
        if (!confirm(`\u9690\u85CF\u9009\u4E2D\u7684 ${ids.length} \u4E2A\u6279\u6B21\uFF1F\u6570\u636E\u4ECD\u53EF\u8865\u4E0B\u8F7D\u3002`)) return;
        ids.forEach((id) => {
          processedNodeIds.add(id);
          delete batches[id];
        });
        logI(`\u5DF2\u9690\u85CF ${ids.length} \u4E2A\u6279\u6B21\uFF08\u4FDD\u7559\u672C\u5730\u5B58\u50A8\uFF09`);
        refreshList();
      };
      const bClr = document.createElement("button");
      bClr.textContent = "\u9690\u85CF\u5168\u90E8";
      styleBtn(bClr, "danger");
      bClr.onclick = () => {
        if (!Object.keys(batches).length) return;
        if (confirm("\u9690\u85CF\u5F53\u524D\u5217\u8868\uFF1F\u672C\u5730\u8BB0\u5F55\u4FDD\u7559\uFF0C\u53EF\u8865\u4E0B\u8F7D\u3002")) clearAll();
      };
      const bIsolation = document.createElement("button");
      bIsolation.textContent = "\u4E0B\u8F7D\u9694\u79BB\u5305";
      styleBtn(bIsolation);
      bIsolation.onclick = () => exportQuarantine().catch((e) => logE(e.message));
      const bHistory = document.createElement("button");
      bHistory.textContent = "\u5386\u53F2\u8865\u4E0B\u8F7D";
      styleBtn(bHistory);
      bHistory.onclick = () => downloadBatches([...engine.batches.values()], "\u5386\u53F2", false).catch((e) => logE(e.message));
      const bRetry = document.createElement("button");
      bRetry.textContent = "\u8865\u91C7\u5F53\u524D\u8282\u70B9";
      styleBtn(bRetry);
      bRetry.onclick = () => {
        if (AUTO.running) return logW("\u8BF7\u5148\u7EC8\u6B62\u81EA\u52A8\u91C7\u96C6");
        const b = engine.begin(readContext(), true);
        if (b) {
          const k = readFilter(F.keyword);
          clickBoundKeyword(k.el);
          logI("\u5DF2\u65B0\u5EFA\u8865\u91C7\u8F6E\u6B21\u5E76\u70B9\u51FB\u5F53\u524D\u5173\u952E\u8BCD\uFF1B\u82E5\u9875\u9762\u672A\u91CD\u53D1\u8BF7\u6C42\uFF0C\u8BF7\u5207\u6362\u5230\u5176\u4ED6\u5173\u952E\u8BCD\u518D\u5207\u56DE");
        }
      };
      bar.append(bAll, bInv, bDl, bDel, bClr, bIsolation, bHistory, bRetry);
      listBox = document.createElement("div");
      Object.assign(listBox.style, { flex: "1 1 auto", minHeight: "0", overflowY: "auto" });
      const logHead = document.createElement("div");
      Object.assign(logHead.style, {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        margin: "6px 0 3px",
        flex: "0 0 auto"
      });
      const lt = document.createElement("span");
      lt.textContent = "\u8FD0\u884C\u65E5\u5FD7";
      lt.style.fontWeight = "bold";
      const lbtns = document.createElement("div");
      lbtns.style.display = "flex";
      lbtns.style.gap = "4px";
      const bLogDl = document.createElement("button");
      bLogDl.textContent = "\u4E0B\u8F7D\u65E5\u5FD7";
      styleBtn(bLogDl);
      bLogDl.onclick = downloadLog;
      const bLogClr = document.createElement("button");
      bLogClr.textContent = "\u6E05\u7A7A\u65E5\u5FD7";
      styleBtn(bLogClr);
      bLogClr.onclick = () => {
        logs.length = 0;
        logBox.innerHTML = "";
      };
      lbtns.append(bLogDl, bLogClr);
      logHead.append(lt, lbtns);
      logBox = document.createElement("div");
      Object.assign(logBox.style, {
        flex: "0 0 150px",
        minHeight: "60px",
        overflowY: "auto",
        background: "rgba(0,0,0,.45)",
        borderRadius: "4px",
        padding: "4px 6px",
        fontFamily: "Consolas,Monaco,monospace",
        fontSize: "11px",
        lineHeight: "1.5"
      });
      panel.append(header, cfg, bar, listBox, logHead, logBox);
      document.body.appendChild(panel);
      makeDraggable(panel, header);
      logs.forEach((l) => {
        const d = document.createElement("div");
        d.textContent = `[${l.ts}] ${l.msg}`;
        d.style.color = l.level === "E" ? "#ff8a80" : l.level === "W" ? "#ffd54f" : "#c8e6c9";
        logBox.appendChild(d);
      });
      syncLevelUI();
      syncAutoUI();
      refreshList();
      logI(`\u811A\u672C\u5DF2\u5C31\u7EEA v${VERSION}\uFF1B\u5F52\u5C5E\u4E0D\u660E\u786E\u7684\u54CD\u5E94\u5C06\u9694\u79BB`);
    }
    function makeDraggable(el, handle) {
      let ox = 0, oy = 0, on = false;
      handle.addEventListener("mousedown", (e) => {
        if (e.target.tagName === "BUTTON" || e.target.tagName === "INPUT") return;
        on = true;
        const rect = el.getBoundingClientRect();
        ox = e.clientX - rect.left;
        oy = e.clientY - rect.top;
        document.addEventListener("mousemove", mv);
        document.addEventListener("mouseup", up);
        e.preventDefault();
      });
      function mv(e) {
        if (!on) return;
        el.style.left = e.clientX - ox + "px";
        el.style.top = e.clientY - oy + "px";
      }
      function up() {
        on = false;
        document.removeEventListener("mousemove", mv);
        document.removeEventListener("mouseup", up);
      }
    }
    function syncLevelUI() {
      Object.entries(lvBoxes).forEach(([k, cb]) => {
        cb.checked = AUTO.levels[k];
        cb.disabled = k === "keyword" || AUTO.running;
      });
    }
    function syncAutoUI() {
      if (!startBtn) return;
      startBtn.disabled = AUTO.running;
      startBtn.style.opacity = AUTO.running ? ".5" : "1";
      startBtn.textContent = AUTO.running ? "\u6293\u53D6\u4E2D\u2026" : "\u5F00\u59CB\u81EA\u52A8\u6293\u53D6";
      stopBtn.disabled = !AUTO.running;
      stopBtn.style.opacity = AUTO.running ? "1" : ".5";
      stopBtn.textContent = AUTO.stopping ? "\u6B63\u5728\u7EC8\u6B62\u2026" : "\u7EC8\u6B62\u81EA\u52A8\u6293\u53D6";
      [targetInput, totalInput, dMinInput, dMaxInput].forEach((i2) => {
        if (i2) {
          i2.disabled = AUTO.running;
          i2.style.opacity = AUTO.running ? ".55" : "1";
        }
      });
      syncLevelUI();
    }
    function updateProgress() {
      if (!progEl) return;
      const c = readContext();
      progEl.textContent = `\u5173\u952E\u8BCD ${c.keyword.index}/${c.keyword.total}\u3000\u5546\u54C1\u7C7B\u578B ${c.product_type.index}/${c.product_type.total}\u3000\u7C7B\u522B ${c.category.index}/${c.category.total}\u3000\u5546\u5E97 ${c.store.index}/${c.store.total}` + (AUTO.running ? `\u3000\uFF5C\u672C\u6B21\u5DF2\u6293 ${AUTO.totalCaptured}` + (AUTO.totalLimit > 0 ? ` / ${AUTO.totalLimit}` : "") : "");
    }
    function updateStats() {
      if (!statsEl) return;
      const ids = Object.keys(batches);
      let files = 0, bytes = 0;
      ids.forEach((id) => Object.values(batches[id].files).forEach((f) => {
        files++;
        bytes += f.blob.size;
      }));
      statsEl.textContent = `\u6279\u6B21 ${ids.length} \xB7 \u9694\u79BB ${engine.quarantines.size} \xB7 \u6587\u4EF6 ${files} \xB7 ${formatBytes(bytes)}`;
    }
    function refreshList() {
      if (!listBox) return;
      updateStats();
      updateProgress();
      const savedScroll = listBox.scrollTop;
      listBox.innerHTML = "";
      const ids = Object.keys(batches).sort((a, b) => (batches[b].updatedAt || batches[b].createdAt) - (batches[a].updatedAt || batches[a].createdAt));
      if (!ids.length) {
        const e = document.createElement("div");
        e.textContent = "\u6682\u65E0\u6570\u636E\uFF0C\u5207\u6362\u7C7B\u76EE\u8282\u70B9\u540E\u4F1A\u663E\u793A\u6293\u53D6\u7ED3\u679C\u3002";
        e.style.color = "#ccc";
        listBox.appendChild(e);
        return;
      }
      ids.forEach((nodeId) => {
        const b = batches[nodeId];
        const w = document.createElement("div");
        Object.assign(w.style, {
          border: "1px solid #555",
          padding: "4px 6px",
          marginBottom: "4px",
          borderRadius: "4px",
          background: "rgba(40,40,40,.9)"
        });
        const r1 = document.createElement("div");
        Object.assign(r1.style, {
          display: "grid",
          gridTemplateColumns: "20px 1fr auto auto",
          alignItems: "center",
          columnGap: "6px"
        });
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !!b.checked;
        cb.style.margin = "0 auto";
        cb.onchange = () => {
          b.checked = cb.checked;
        };
        const kwName = b.ctx && b.ctx.keyword && b.ctx.keyword.label || b.nodeId;
        const fileCount = Object.keys(b.files).length;
        const lb = document.createElement("div");
        lb.textContent = `${kwName}\uFF08${b.nodeId}\uFF09[${fileCount}/4]${b.timedOut ? " \u7F3A\u5931" : ""}${b.supplementOf ? " \u8865\u5145" : ""}`;
        if (b.ctx && b.ctx.store) {
          lb.title = [
            b.ctx.store.label,
            b.ctx.category.label,
            b.ctx.product_type.label,
            b.ctx.keyword.label
          ].join(" / ");
        }
        Object.assign(lb.style, { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
        const bd = document.createElement("button");
        bd.textContent = "\u4E0B\u8F7D";
        styleBtn(bd);
        bd.onclick = () => downloadSingle(nodeId);
        const bx = document.createElement("button");
        bx.textContent = "\u9690\u85CF";
        styleBtn(bx);
        bx.onclick = () => {
          delete batches[nodeId];
          processedNodeIds.add(nodeId);
          logI(`\u5DF2\u9690\u85CF\u6279\u6B21\uFF08\u4FDD\u7559\u672C\u5730\u8BB0\u5F55\uFF09`);
          refreshList();
        };
        r1.append(cb, lb, bd, bx);
        const r15 = document.createElement("div");
        const catName = b.ctx && b.ctx.category && b.ctx.category.label || "-";
        const pdtName = b.ctx && b.ctx.product_type && b.ctx.product_type.label || "-";
        r15.textContent = `${catName} / ${pdtName}`;
        Object.assign(r15.style, {
          fontSize: "10px",
          color: "#9e9e9e",
          margin: "2px 0 0 20px",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis"
        });
        const r2 = document.createElement("div");
        Object.assign(r2.style, {
          display: "grid",
          gridTemplateColumns: "20px repeat(4,auto)",
          alignItems: "center",
          columnGap: "4px",
          marginTop: "3px"
        });
        r2.appendChild(document.createElement("div"));
        TYPE_LABELS.forEach((t) => {
          const tag = document.createElement("div");
          tag.textContent = t.label;
          styleTag(tag, !!b.files[t.key]);
          r2.appendChild(tag);
        });
        w.append(r1, r15, r2);
        listBox.appendChild(w);
      });
      listBox.scrollTop = savedScroll;
    }
    function snapshotContext() {
      try {
        return readContext();
      } catch {
        return { store: { value: "", label: "" }, category: { value: "", label: "" }, product_type: { value: "", label: "" }, keyword: { value: "", label: "" }, nodeId: null };
      }
    }
    function bodyForObservation(body) {
      if (body instanceof FormData) return Object.fromEntries(body.entries());
      if (body instanceof Blob) return body.text();
      return body;
    }
    function guardedFinish(ticket, status, text) {
      return Promise.resolve(ticket).then((t) => engine.finish(t, status, text)).catch((e) => {
        logE(`\u76D1\u542C\u5931\u8D25\uFF1A${e.message}`);
      });
    }
    const origFetch = window.fetch;
    window.fetch = function(input, init) {
      const url = toUrlString(input);
      let target = false;
      try {
        target = !!endpoint(url);
      } catch {
      }
      if (!target) return origFetch.apply(this, arguments);
      const ctx = snapshotContext(), started = Date.now();
      let body;
      try {
        body = init && Object.hasOwn(init, "body") ? bodyForObservation(init.body) : input instanceof Request ? input.clone().text() : null;
      } catch {
        body = null;
      }
      let ticket;
      if (body && typeof body.then === "function") {
        const dispatch = engine.reserve();
        ticket = Promise.resolve(body).then((value) => engine.start(url, value, ctx, started, dispatch), () => engine.start(url, null, ctx, started, dispatch));
      } else ticket = engine.start(url, body, ctx, started);
      let result;
      try {
        result = origFetch.apply(this, arguments);
      } catch (e) {
        guardedFinish(ticket, 0, "");
        throw e;
      }
      result.then((response) => {
        try {
          return response.clone().text().then((raw) => guardedFinish(ticket, response.status, raw), () => guardedFinish(ticket, response.status, ""));
        } catch {
          return guardedFinish(ticket, response.status, "");
        }
      }, () => guardedFinish(ticket, 0, "")).catch((e) => logE(`fetch\u76D1\u542C\u5931\u8D25\uFF1A${e.message}`));
      return result;
    };
    const origOpen = XMLHttpRequest.prototype.open, origSend = XMLHttpRequest.prototype.send;
    const xhrMeta = /* @__PURE__ */ new WeakMap();
    XMLHttpRequest.prototype.open = function(method, url) {
      xhrMeta.set(this, { url: toUrlString(url) });
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function(data) {
      const m = xhrMeta.get(this);
      let target = false;
      try {
        target = !!endpoint(m?.url || "");
      } catch {
      }
      if (target) {
        const ctx = snapshotContext(), started = Date.now();
        const body = bodyForObservation(data);
        const dispatch = engine.reserve();
        const ticket = body && typeof body.then === "function" ? Promise.resolve(body).then((x2) => engine.start(m.url, x2, ctx, started, dispatch), () => engine.start(m.url, null, ctx, started, dispatch)) : engine.start(m.url, body, ctx, started, dispatch);
        this.addEventListener("loadend", () => {
          let raw = "";
          try {
            raw = this.responseType === "json" ? JSON.stringify(this.response) : this.responseType === "" || this.responseType === "text" ? this.responseText : "";
          } catch {
          }
          guardedFinish(ticket, this.status, raw);
        }, { once: true });
      }
      return origSend.apply(this, arguments);
    };
    let transitionExpected = null;
    function beginTransition(level, value) {
      engine.transition = true;
      transitionExpected = { level, value, since: engine.seq };
    }
    document.addEventListener("click", (event) => {
      if (panel?.contains(event.target)) return;
      const radio = event.composedPath().find((el) => el?.tagName?.toLowerCase() === "kat-radiobutton");
      const name = radio?.getAttribute("name");
      if (event.isTrusted && AUTO.running && Object.values(F).includes(name)) {
        AUTO.stopping = true;
        logW("\u68C0\u6D4B\u5230\u624B\u52A8\u5207\u6362\u7B5B\u9009\u5668\uFF0C\u7EC8\u6B62\u81EA\u52A8\u904D\u5386\u5E76\u4FDD\u7559\u5F53\u524D\u7ED3\u679C");
      }
      if ([F.store, F.category, F.ptype].includes(name)) {
        beginTransition(Object.keys(F).find((k) => F[k] === name), radio.getAttribute("value"));
      }
      if (name === F.keyword) {
        const ctx = snapshotContext(), value = radio.getAttribute("value");
        ctx.keyword = { value, label: radio.getAttribute("label") || value, index: 0, total: 0 };
        ctx.nodeId = value;
        const list = engine.catalog.get(JSON.stringify(pathOf(ctx).slice(0, 3)));
        const pkey = JSON.stringify(pathOf(ctx).slice(0, 3));
        const settled = !transitionExpected || readFilter(F[transitionExpected.level]).value === transitionExpected.value && (engine.directorySequence.get(pkey) || 0) > transitionExpected.since;
        if (list?.has(value) && settled) {
          engine.transition = false;
          transitionExpected = null;
          if (!presetRoundClick) engine.begin(ctx, true);
        }
      }
    }, true);
    setInterval(() => {
      const ctx = snapshotContext(), list = engine.catalog.get(JSON.stringify(pathOf(ctx).slice(0, 3)));
      const parent = JSON.stringify(pathOf(ctx).slice(0, 3));
      if (transitionExpected && readFilter(F[transitionExpected.level]).value === transitionExpected.value && (engine.directorySequence.get(parent) || 0) > transitionExpected.since && list?.has(ctx.keyword.value)) {
        engine.transition = false;
        transitionExpected = null;
      }
    }, 200);
    logI("document-start\uFF1Afetch/XHR \u76D1\u542C\u5DF2\u5B89\u88C5\uFF0C\u7B49\u5F85\u624B\u52A8\u5F00\u59CB\u904D\u5386");
    function boot() {
      if (document.body) {
        createPanel();
        setInterval(updateProgress, 2e3);
      } else setTimeout(boot, 300);
    }
    boot();
    console.log(`[Tampermonkey] Amazon \u7C7B\u76EE\u6D1E\u5BDF\u6570\u636E\u91C7\u96C6\u5668 v${VERSION} loaded`);
  })();
})();
