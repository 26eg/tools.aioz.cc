// ==UserScript==
// @name         气弹簧产品信息抓取
// @namespace    https://github.com/26eg/tools.aioz.cc
// @version      1.2.2
// @description  自动抓取气弹簧产品页面的5类信息，在新标签页展示并支持一键复制
// @author       26eg
// @homepageURL  https://tools.aioz.cc/tampermonkey-scripts/
// @updateURL    https://tools.aioz.cc/tampermonkey-scripts/gas-spring-scraper/gas-spring-scraper.user.js
// @downloadURL  https://tools.aioz.cc/tampermonkey-scripts/gas-spring-scraper/gas-spring-scraper.user.js
// @match        https://www.liftsupportsdepot.com/*
// @match        https://webcache.yiparts.com/*
// @grant        GM_xmlhttpRequest
// @connect      www.liftsupportsdepot.com
// @connect      liftsupportsdepot.myconvermax.com
// @connect      webcache.yiparts.com
// @run-at       document-idle
// ==/UserScript==

/*
  run-at 说明：
  - document-start 会在 HTML 解析前执行，此时 document.body 不存在，
    无法注入按钮，也无法用 DOMParser。
  - document-idle（默认）在页面完全加载后执行，适合本脚本的「加载完就抓」模式。
    真正影响速度的是 GM_xmlhttpRequest 的网络请求，与 run-at 无关。
*/

(function () {
  'use strict';

  // ============================================================
  //  全局工具
  // ============================================================

  function showToast(message, duration) {
    duration = duration || 3000;
    var toast = document.createElement('div');
    toast.style.cssText = [
      'position:fixed', 'top:20px', 'left:50%', 'transform:translateX(-50%)',
      'background:#333', 'color:#fff', 'padding:10px 24px',
      'border-radius:6px', 'z-index:2147483647', 'font-size:14px',
      'box-shadow:0 2px 8px rgba(0,0,0,.4)', 'pointer-events:none'
    ].join(';');
    toast.innerText = message;
    document.body.appendChild(toast);
    setTimeout(function () {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, duration);
  }

  function escapeHtml(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ============================================================
  //  站点模块注册表
  //
  //  每个模块实现：
  //    name        string    模块标识
  //    match(url)  → bool    是否为目标产品页
  //    fetchData(url, cb)
  //                → void    cb(err, result, fitmentJSON)
  //      result = {
  //        techInfoHTML : string   专业网站参数（HTML片段，空串=""）
  //        partNumbers  : string   零件编号（纯文本，空串=""）
  //        fitment      : string   适配车型（制表符分隔纯文本，空串=""）
  //        location     : string   适配位置（纯文本，空串=""）
  //        link         : string   参数链接（URL）
  //      }
  //      fitmentJSON : object|null  原始JSON，供渲染HTML表格
  // ============================================================

  var SITE_MODULES = [];

  // ============================================================
  //  站点 #1：liftsupportsdepot.com
  // ============================================================

  SITE_MODULES.push({
    name: 'liftsupportsdepot',

    match: function (url) {
      if (!/liftsupportsdepot\.com/.test(url)) return false;
      // 排除非产品页
      if (/liftsupportsdepot\.com\/$/.test(url)) return false;
      if (/liftsupportsdepot\.com\/(search|categories|cart|account|login|checkout|brands|sitemap|blog)/.test(url)) return false;
      return /liftsupportsdepot\.com\/[a-z0-9][^?#]*\//.test(url);
    },

    fetchData: function (url, cb) {
      // 脚本在 document-idle 时已运行于产品页本身，页面 HTML 由服务端完整渲染，
      // 所需字段（ul.technical-information 等）都已存在于当前 DOM 中。
      // 因此直接读取当前 document，不再对同一 URL 发第二次网络请求。
      //
      // 旧版通过 GM_xmlhttpRequest 重新抓取同一页面，站点接入 Cloudflare 机器人
      // 防护后，该同源重复请求被拦截返回 HTTP 403，导致"抓取失败"。改读 DOM
      // 可彻底规避，同时更快。（跨域的适配车型 API 仍需网络请求，见下方。）
      var doc = document;

      // ── 专业网站参数 ──
      var techInfoEl = doc.querySelector('ul.technical-information');
      var techInfoHTML = '';
      if (techInfoEl) {
        var clone = techInfoEl.cloneNode(true);
        clone.querySelectorAll('[style]').forEach(function (el) { el.removeAttribute('style'); });

        // 按自定义顺序重排 <li>：优先字段前置，缺失字段插入空占位
        reorderTechInfoLi(clone, [
          'SKU:',
          'Custom Qty:',
          'Extended Length A [in]:',
          'Compressed Length B [in]:',
          'Stroke C [in]:',
          'Force (Lbs):',
          'Force Newtons:',
          'Body Connection:',
          'Shaft Connection:',
          'End Fitting Size:',
          'End Fitting Type:',
          'Cylinder Diameter (MM):',
          'Rod Diameter (MM):',
          'Vehicle Location:',
          'A Interchanges:'
        ]);

        techInfoHTML = clone.outerHTML;
      }

      // ── 零件编号 ──
      var partNumbers = '';
      if (techInfoEl) {
        var interEl = techInfoEl.querySelector('.a-interchanges span');
        if (interEl) partNumbers = interEl.textContent.trim();
      }

      // ── 适配位置 ──
      var vehicleLocation = '';
      var locEl = doc.querySelector('li.vehicle-location span');
      if (locEl) vehicleLocation = locEl.textContent.trim();

      // ── productId ──
      var productId = '';
      var ogImage = doc.querySelector('meta[property="og:image"]');
      if (ogImage && ogImage.getAttribute('content')) {
        var m = ogImage.getAttribute('content').match(/\/products\/(\d+)\//);
        if (m) productId = m[1];
      }
      if (!productId) {
        var pidInput = doc.querySelector('input[name="product_id"]');
        if (pidInput) productId = pidInput.value;
      }

      var result = {
        techInfoHTML: techInfoHTML,
        partNumbers: partNumbers,
        fitment: '',
        location: vehicleLocation,
        link: url
      };

      if (!productId) { cb(null, result, null); return; }

      // ── 适配车型 API（跨域到 myconvermax，仍需网络请求；失败不影响主流程）──
      GM_xmlhttpRequest({
        method: 'GET',
        url: 'https://liftsupportsdepot.myconvermax.com/ymm/fitments.json?productId=' + productId,
        headers: { 'Accept': 'application/json' },
        onload: function (resp2) {
          var fitmentJSON = null;
          if (resp2.status >= 200 && resp2.status < 300) {
            try { fitmentJSON = JSON.parse(resp2.responseText); } catch (e) {}
          }
          if (fitmentJSON) result.fitment = buildFitmentText(fitmentJSON);
          cb(null, result, fitmentJSON);
        },
        onerror: function () { cb(null, result, null); }
      });
    }
  });

  // ============================================================
  //  站点 #2：webcache.yiparts.com
  //  抓取：零件编号、适配车型、参数链接
  //  其余字段（专业网站参数、适配位置）留空
  // ============================================================

  SITE_MODULES.push({
    name: 'yiparts',

    match: function (url) {
      return /webcache\.yiparts\.com\/item/.test(url);
    },

    fetchData: function (url, cb) {
      // yiparts 页面是动态渲染（React/Vue），直接 fetch HTML 无法获取渲染后内容。
      // 改为读取当前已渲染的 DOM（脚本在 document-idle 时执行，页面已渲染完毕）。
      var result = {
        techInfoHTML: '',
        partNumbers: '',
        fitment: '',
        location: '',
        link: url
      };

      try {
        // ── 零件编号 ──
        // 对应 JS书签中的 .c-faded-area.my-5 内容
        var fadedArea = document.querySelector('.c-faded-area.my-5');
        if (fadedArea) {
          var lines = [];

          // 第1个 headline + 第1个 u-bg-white 块
          var headlines = fadedArea.querySelectorAll('span.c-headline.mt-4');
          var bgWhites  = fadedArea.querySelectorAll('div.u-bg-white.p-4.mt-1');

          if (headlines[0]) lines.push(headlines[0].textContent.trim());
          if (bgWhites[0]) {
            bgWhites[0].querySelectorAll('div.row > div').forEach(function (div) {
              var t = div.textContent.trim();
              if (t) lines.push(t);
            });
          }
          if (headlines[1]) lines.push(headlines[1].textContent.trim());
          if (bgWhites[1]) {
            bgWhites[1].querySelectorAll('div.row > div').forEach(function (div) {
              var t = div.textContent.trim();
              if (t) lines.push(t);
            });
          }
          result.partNumbers = lines.join('\n');
        }

        // ── 适配车型 ──
        // 对应 JS书签中的 div#model-list.u-bg-white.p-4.mt-1
        var modelList = document.querySelector('div#model-list.u-bg-white.p-4.mt-1');
        if (modelList) {
          var fitLines = [];
          modelList.querySelectorAll('div.row.py-2').forEach(function (row) {
            var rowText = Array.from(row.children).map(function (child) {
              return child.textContent.trim();
            }).join('\t');
            if (rowText.trim()) fitLines.push(rowText);
          });
          result.fitment = fitLines.join('\n');
        }

      } catch (e) {
        // DOM 解析出错，保留空值即可
      }

      cb(null, result, null);
    }
  });

  // ============================================================
  //  专业网站参数 <li> 重排序（按优先级前置指定字段，缺失则插入空占位）
  // ============================================================

  function reorderTechInfoLi(ulElement, priorityLabels) {
    var allLi = ulElement.querySelectorAll('li');
    if (!allLi || allLi.length === 0) return;

    // 建立 label → <li> 的映射（通过 <b> 标签文本匹配）
    var labelToLi = {};
    var used = {};         // 标记已匹配的 <li>
    var liIdMap = {};       // <li> → 临时唯一标识（用于去重）

    allLi.forEach(function (li, idx) {
      var b = li.querySelector('b');
      if (b) {
        var label = (b.textContent || '').trim();
        if (label) {
          // 后来者不覆盖（keep first match）
          if (!labelToLi.hasOwnProperty(label)) {
            labelToLi[label] = li;
            liIdMap[label] = idx;
          }
        }
      }
    });

    // 按优先级收集匹配到的 <li>，同时标记为"已用"
    var orderedLi = [];
    var usedIdx = {};
    priorityLabels.forEach(function (label) {
      var li = labelToLi[label];
      if (li) {
        // 找到该 <li> 在 allLi 中的索引
        for (var i = 0; i < allLi.length; i++) {
          if (allLi[i] === li) { usedIdx[i] = true; break; }
        }
        orderedLi.push(li);
      } else {
        // 字段缺失 → 创建空占位 <li>
        var placeholder = document.createElement('li');
        placeholder.innerHTML = '<b>' + label + '</b><span></span>';
        orderedLi.push(placeholder);
      }
    });

    // 追加未匹配的 <li>（保持原序）
    allLi.forEach(function (li, i) {
      if (!usedIdx[i]) orderedLi.push(li);
    });

    // 重建 <ul> 内容
    ulElement.innerHTML = '';
    orderedLi.forEach(function (li) { ulElement.appendChild(li); });
  }

  // ============================================================
  //  适配车型 JSON → Tab 分隔纯文本（供复制）
  // ============================================================

  function buildFitmentText(json) {
    if (!json || !json.Fitments || json.Fitments.length === 0) return '';
    var fields = json.Fields ? json.Fields.map(function (f) { return f.Name; }) : ['Year', 'Make', 'Model', 'Trim'];
    var lines = [fields.join('\t')];
    json.Fitments.forEach(function (row) {
      lines.push(fields.map(function (f) { return row[f] || ''; }).join('\t'));
    });
    return lines.join('\n');
  }

  // ============================================================
  //  适配车型 JSON → HTML 表格（供展示）
  // ============================================================

  function buildFitmentTableHTML(json) {
    if (!json || !json.Fitments || json.Fitments.length === 0) return '';
    var fields = json.Fields ? json.Fields.map(function (f) { return f.Name; }) : ['Year', 'Make', 'Model', 'Trim'];
    var html = '<table id="fitment-inner-table" style="width:100%;border-collapse:collapse;table-layout:fixed;word-wrap:break-word;">';
    html += '<thead><tr>' + fields.map(function (f) { return '<th>' + escapeHtml(f) + '</th>'; }).join('') + '</tr></thead>';
    html += '<tbody>';
    json.Fitments.forEach(function (row) {
      html += '<tr>' + fields.map(function (f) { return '<td>' + escapeHtml(row[f] || '') + '</td>'; }).join('') + '</tr>';
    });
    html += '</tbody></table>';
    return html;
  }

  // ============================================================
  //  适配车型纯文本 → HTML 表格（yiparts 等非JSON来源）
  // ============================================================

  function buildFitmentTableFromText(text) {
    if (!text) return '';
    var lines = text.split('\n').filter(function (l) { return l.trim(); });
    if (lines.length === 0) return '';
    var html = '<table id="fitment-inner-table" style="width:100%;border-collapse:collapse;table-layout:fixed;word-wrap:break-word;"><tbody>';
    lines.forEach(function (line) {
      var cells = line.split('\t');
      html += '<tr>' + cells.map(function (c) { return '<td>' + escapeHtml(c) + '</td>'; }).join('') + '</tr>';
    });
    html += '</tbody></table>';
    return html;
  }

  // ============================================================
  //  结果页面生成（固定表头版）
  // ============================================================

  function openResultPage(result, fitmentJSON) {
    var newPage = window.open('', '_blank');
    if (!newPage) {
      showToast('无法打开新页面，请允许弹出窗口', 4000);
      return;
    }

    // 专业网站参数纯文本
    var techInfoText = '';
    if (result.techInfoHTML) {
      var tmp = document.createElement('div');
      tmp.innerHTML = result.techInfoHTML;
      var liLines = [];
      tmp.querySelectorAll('li').forEach(function (li) {
        var t = (li.innerText || li.textContent).replace(/\s+/g, ' ').trim();
        if (t) liLines.push(t);
      });
      techInfoText = liLines.join('\n');
    }

    // 适配车型 HTML 表格
    var fitmentTableHTML = '';
    if (fitmentJSON) {
      fitmentTableHTML = buildFitmentTableHTML(fitmentJSON);
    } else if (result.fitment) {
      fitmentTableHTML = buildFitmentTableFromText(result.fitment);
    }

    var techInfoDisplay   = result.techInfoHTML || '<span style="color:#aaa">—</span>';
    var fitmentDisplay    = fitmentTableHTML    || '<span style="color:#aaa">—</span>';
    var partDisplay       = escapeHtml(result.partNumbers || '');
    var locationDisplay   = escapeHtml(result.location   || '');

    // 将数据安全序列化给内嵌JS
    var dataSafe = JSON.stringify({
      techInfo    : techInfoText,
      partNumbers : result.partNumbers || '',
      fitment     : result.fitment     || '',
      location    : result.location    || '',
      link        : result.link        || ''
    });

    var pageHTML = '<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8">';
    pageHTML += '<title>产品信息</title>';
    pageHTML += '<style>';

    // ── 布局：固定顶部 toolbar + thead ──
    pageHTML += '*{box-sizing:border-box;}';
    pageHTML += 'html,body{margin:0;padding:0;height:100%;font-family:sans-serif;background:#fafafa;}';

    // 固定顶部区域（toolbar + 表头）
    pageHTML += '#fixed-top{position:fixed;top:0;left:0;right:0;z-index:1000;background:#fafafa;border-bottom:2px solid #ccc;}';
    pageHTML += '.toolbar{display:flex;align-items:center;gap:10px;padding:10px 12px;flex-wrap:wrap;}';
    pageHTML += '.copy-all-btn{padding:9px 20px;font-size:15px;font-weight:bold;background:#4a90e2;color:#fff;border:none;border-radius:6px;cursor:pointer;white-space:nowrap;}';
    pageHTML += '.copy-all-btn:hover{background:#2e72c8;}';
    pageHTML += '.status-done{background:#d4edda;color:#155724;padding:4px 10px;border-radius:4px;font-size:13px;}';
    pageHTML += '.src-link{font-size:12px;color:#666;}';
    pageHTML += '.src-link a{color:#1a6fc4;}';

    // 固定表头
    pageHTML += '#fixed-thead{width:100%;border-collapse:collapse;table-layout:fixed;}';
    pageHTML += '#fixed-thead th{border:1px solid #aaa;padding:4px;background:#e8e8e8;text-align:left;}';
    pageHTML += 'button.col-copy{width:100%;padding:6px 4px;cursor:pointer;border:1px solid #ccc;background:#e7e7e7;border-radius:4px;font-size:13px;}';
    pageHTML += 'button.col-copy:hover{background:#d0d0d0;}';

    // 滚动内容区（留出顶部固定区高度，由JS动态计算）
    pageHTML += '#scroll-body{overflow-y:auto;position:absolute;left:0;right:0;bottom:0;}';
    pageHTML += 'table.data-table{width:100%;border-collapse:collapse;table-layout:fixed;word-wrap:break-word;}';
    pageHTML += 'table.data-table td{border:1px solid #aaa;border-top:none;padding:8px;vertical-align:top;}';
    pageHTML += '#fitment-inner-table{width:100%;border-collapse:collapse;table-layout:fixed;word-wrap:break-word;font-size:13px;}';
    pageHTML += '#fitment-inner-table th,#fitment-inner-table td{border:1px solid #ddd;padding:5px;background:#fff;}';
    pageHTML += '#fitment-inner-table th{background:#f5f5f5;}';
    pageHTML += '.link-cell a{color:#1a6fc4;word-break:break-all;}';
    pageHTML += '.toast{position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:10px 20px;border-radius:5px;z-index:9999;font-size:14px;pointer-events:none;}';
    pageHTML += 'ul.technical-information{margin:0;padding-left:18px;}';
    pageHTML += 'ul.technical-information li{margin-bottom:3px;font-size:13px;}';
    pageHTML += '</style>';

    // ── 内嵌 JS ──
    pageHTML += '<script>';

    // 数据
    pageHTML += 'var DATA=' + dataSafe + ';';

    // toast
    pageHTML += 'function showToast(msg){var t=document.createElement("div");t.className="toast";t.innerText=msg;document.body.appendChild(t);setTimeout(function(){if(t.parentNode)t.parentNode.removeChild(t);},2500);}';

    // 复制（优先 Clipboard API，降级 execCommand）
    pageHTML += 'function copyText(text){';
    pageHTML += 'if(navigator.clipboard&&window.isSecureContext){';
    pageHTML += 'navigator.clipboard.writeText(text).then(function(){showToast("已复制到剪贴板");}).catch(function(){fallbackCopy(text);});';
    pageHTML += '}else{fallbackCopy(text);}}';
    pageHTML += 'function fallbackCopy(text){var ta=document.createElement("textarea");ta.value=text;ta.style.cssText="position:fixed;top:-9999px;left:-9999px;";document.body.appendChild(ta);ta.focus();ta.select();';
    pageHTML += 'try{document.execCommand("copy");showToast("已复制到剪贴板");}catch(e){showToast("复制失败: "+e);}';
    pageHTML += 'document.body.removeChild(ta);}';

    // 单列复制
    pageHTML += 'function copyCol(key){copyText(DATA[key]);}';

    // 一键复制全部（TSV，空值安全）
    pageHTML += 'function copyAll(){';
    pageHTML += 'function tsvCell(s){';
    pageHTML += 'if(!s)return"";';                              // 空值直接给空串，不影响相邻 Tab
    pageHTML += 'if(s.indexOf("\\t")>=0||s.indexOf("\\n")>=0||s.indexOf("\\"")>=0){';
    pageHTML += 'return "\\""+s.replace(/\\"/g,"\\"\\"")+"\\"";';
    pageHTML += '}return s;}';
    pageHTML += 'var row=[DATA.techInfo,DATA.partNumbers,DATA.fitment,DATA.location,DATA.link].map(tsvCell).join("\\t");';
    pageHTML += 'copyText(row);}';

    // 固定顶部高度动态同步
    pageHTML += 'function syncHeight(){';
    pageHTML += 'var fixed=document.getElementById("fixed-top");';
    pageHTML += 'var scroll=document.getElementById("scroll-body");';
    pageHTML += 'if(fixed&&scroll){scroll.style.top=fixed.offsetHeight+"px";}';
    pageHTML += '}';
    pageHTML += 'window.addEventListener("load",syncHeight);';
    pageHTML += 'window.addEventListener("resize",syncHeight);';

    pageHTML += '</script>';
    pageHTML += '</head><body>';

    // ── 固定顶部 ──
    pageHTML += '<div id="fixed-top">';

    // toolbar
    pageHTML += '<div class="toolbar">';
    pageHTML += '<button class="copy-all-btn" onclick="copyAll()">📋 一键复制全部（粘贴到5个连续单元格）</button>';
    pageHTML += '<span class="status-done">✅ 数据加载完成</span>';
    pageHTML += '<span class="src-link">来源：<a href="' + escapeHtml(result.link) + '" target="_blank">' + escapeHtml(result.link) + '</a></span>';
    pageHTML += '</div>';

    // 固定表头
    pageHTML += '<table id="fixed-thead">';
    pageHTML += '<colgroup>';
    pageHTML += '<col style="width:22%"><col style="width:18%"><col style="width:32%"><col style="width:10%"><col style="width:18%">';
    pageHTML += '</colgroup>';
    pageHTML += '<thead><tr>';
    pageHTML += '<th><button class="col-copy" onclick="copyCol(\'techInfo\')">📋 专业网站参数</button></th>';
    pageHTML += '<th><button class="col-copy" onclick="copyCol(\'partNumbers\')">📋 零件编号</button></th>';
    pageHTML += '<th><button class="col-copy" onclick="copyCol(\'fitment\')">📋 适配车型</button></th>';
    pageHTML += '<th><button class="col-copy" onclick="copyCol(\'location\')">📋 适配位置</button></th>';
    pageHTML += '<th><button class="col-copy" onclick="copyCol(\'link\')">📋 参数链接</button></th>';
    pageHTML += '</tr></thead>';
    pageHTML += '</table>';

    pageHTML += '</div>'; // end #fixed-top

    // ── 滚动内容区 ──
    pageHTML += '<div id="scroll-body">';
    pageHTML += '<table class="data-table">';
    pageHTML += '<colgroup>';
    pageHTML += '<col style="width:22%"><col style="width:18%"><col style="width:32%"><col style="width:10%"><col style="width:18%">';
    pageHTML += '</colgroup>';
    pageHTML += '<tbody><tr>';
    pageHTML += '<td>' + techInfoDisplay + '</td>';
    pageHTML += '<td style="white-space:pre-wrap;">' + partDisplay + '</td>';
    pageHTML += '<td>' + fitmentDisplay + '</td>';
    pageHTML += '<td>' + locationDisplay + '</td>';
    pageHTML += '<td class="link-cell"><a href="' + escapeHtml(result.link) + '" target="_blank">' + escapeHtml(result.link) + '</a></td>';
    pageHTML += '</tr></tbody>';
    pageHTML += '</table>';
    pageHTML += '</div>'; // end #scroll-body

    // 加载后同步高度
    pageHTML += '<script>syncHeight();</script>';
    pageHTML += '</body></html>';

    newPage.document.open();
    newPage.document.write(pageHTML);
    newPage.document.close();
  }

  // ============================================================
  //  悬浮按钮（自动触发完成后降级为手动重试）
  // ============================================================

  function injectButton(label, onClick) {
    if (document.getElementById('gs-scraper-btn')) return;
    var btn = document.createElement('button');
    btn.id = 'gs-scraper-btn';
    btn.innerText = label;
    btn.style.cssText = [
      'position:fixed', 'bottom:24px', 'right:24px', 'z-index:2147483647',
      'padding:10px 18px', 'font-size:14px', 'font-weight:bold',
      'background:#4a90e2', 'color:#fff', 'border:none', 'border-radius:8px',
      'cursor:pointer', 'box-shadow:0 3px 10px rgba(0,0,0,.3)',
      'transition:background .2s'
    ].join(';');
    btn.addEventListener('mouseenter', function () { btn.style.background = '#2e72c8'; });
    btn.addEventListener('mouseleave', function () { btn.style.background = '#4a90e2'; });
    btn.addEventListener('click', onClick);
    document.body.appendChild(btn);
    return btn;
  }

  function setBtnState(btn, state) {
    if (!btn) return;
    if (state === 'loading') {
      btn.innerText = '⏳ 抓取中...';
      btn.disabled = true;
      btn.style.background = '#888';
    } else if (state === 'done') {
      btn.innerText = '✅ 已完成（点击重新抓取）';
      btn.disabled = false;
      btn.style.background = '#27ae60';
    } else if (state === 'error') {
      btn.innerText = '❌ 失败（点击重试）';
      btn.disabled = false;
      btn.style.background = '#e74c3c';
    } else {
      btn.innerText = '🔍 抓取产品信息';
      btn.disabled = false;
      btn.style.background = '#4a90e2';
    }
  }

  // ============================================================
  //  主入口
  // ============================================================

  function run() {
    var url = window.location.href;

    // 匹配站点模块
    var mod = null;
    for (var i = 0; i < SITE_MODULES.length; i++) {
      if (SITE_MODULES[i].match(url)) { mod = SITE_MODULES[i]; break; }
    }
    if (!mod) return;

    // 先注入按钮（显示"抓取中"状态）
    var btn = injectButton('⏳ 正在自动抓取...', null);
    if (btn) {
      btn.disabled = true;
      btn.style.background = '#888';
    }

    // 定义触发函数（供自动触发和按钮点击共用）
    function doFetch() {
      setBtnState(btn, 'loading');
      mod.fetchData(url, function (err, result, fitmentJSON) {
        if (err) {
          setBtnState(btn, 'error');
          showToast('抓取失败: ' + err, 4000);
          return;
        }
        setBtnState(btn, 'done');
        openResultPage(result, fitmentJSON);
      });
    }

    // 绑定按钮点击（重试 / 重新抓取）
    if (btn) {
      btn.addEventListener('click', function () { doFetch(); });
    }

    // 自动触发（页面加载完毕立即执行）
    doFetch();
  }

  run();

})();
