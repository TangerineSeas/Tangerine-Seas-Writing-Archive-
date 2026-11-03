/* ==========================================================================
   script.js — Tangerine_Seas's Writing Archive 首页
   职责：
     1. 读取 data/works.json，把作品铺进档案柜抽屉
     2. 点击作品标签 → 信封从抽屉里向上抽出
     3. 拖动封条拆信 → 信封下移、信纸升起、三折展开 → 下滑阅读
     4. 关闭 → 信封缩回抽屉
     5. form 为 book 的作品直接取出小册子（复用 admin/preview.js 的书页组件）
   ========================================================================== */

(function () {
  "use strict";

  var WORKS_URL = "data/works.json";
  var TEAR_PROGRESS = 1 / 3;   // 拖过封条宽度的 1/3 就算撕开

  /* 直接双击打开（file://）时浏览器不允许读取目录文件，
     这时用一组内置示例把柜子跑起来，并在页面上明确标注「示例」。 */
  var DEMO_WORKS = [
    {
      number: "TS-DEMO-01",
      title: "Some Stories Begin with a Letter",
      date: "2026-01-12",
      form: "letter",
      bodyHtml:
        "<p>Some stories begin with a letter. Some letters contain an entire world.</p>" +
        "<p>This is a demonstration entry, shown only because the archive catalogue could not be read. " +
        "Once <code>data/works.json</code> is available, real works replace it.</p>" +
        "<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p>" +
        "<p class=\"sig\">Yours sincerely.</p>"
    },
    {
      number: "TS-DEMO-02",
      title: "The Lighthouse Keeper",
      date: "2026-02-03",
      form: "letter",
      bodyHtml:
        "<h2>Chapter One</h2>" +
        "<p>The sea was <strong>unusually quiet</strong> that evening, and the keeper <em>listened</em>.</p>" +
        "<p>He had kept the light for thirty years. In that time the town below had learned to sleep through storms.</p>" +
        "<ul><li>First, the lamp</li><li>Then, the log</li><li>Then, the letter</li></ul>"
    },
    {
      number: "TS-DEMO-03",
      title: "A Note Left in the Margin",
      date: "2026-03-21",
      form: "letter",
      bodyHtml:
        "<p>I found this in a book I bought secondhand: a single line pencilled into the margin, " +
        "and beside it a date from before I was born.</p>" +
        "<blockquote>Nothing here is finished. That is the point.</blockquote>" +
        "<p>I have kept the book. I have not yet decided whether to keep the note.</p>"
    },
    {
      number: "TS-DEMO-04",
      title: "The Cartographer's Daughter",
      date: "2026-04-08",
      form: "book",
      bodyHtml:
        "<p>The maps were never finished. That was the first thing I learned about my father's study: " +
        "nothing in it had an ending.</p>" +
        "<p>He had a way of drawing that made the paper seem deeper than it was. You could put your eye " +
        "close to a river delta and feel the water moving under the ink.</p>" +
        "<h2>Chapter Two</h2>" +
        "<p>I asked him once why he drew a place that no longer existed. He said that a map is not a " +
        "picture of a place. It is an argument about where things belong.</p>" +
        "<p>I did not understand him then. I understood him years later, in a different country, " +
        "holding a folded sheet of tracing paper.</p>"
    }
  ];

  /* ============================ DOM ============================ */

  var $ = function (id) { return document.getElementById(id); };

  var cabinetBody = $("cabinetBody");
  var statusEl    = $("archiveStatus");
  var countEl     = $("archiveCount");

  var reader      = $("reader");
  var readerHint  = $("readerHint");
  var readerClose = $("readerClose");

  var letterScene = $("letterScene");
  var bookScene   = $("bookScene");
  var bookMount   = $("bookMount");
  var bookCaption = $("bookCaption");

  var envelopeFront = $("envelopeFront");
  var envNumber   = $("envNumber");
  var envTitle    = $("envTitle");
  var stampYear   = $("stampYear");

  var hwSheet   = $("hwSheet");
  var hwNo      = $("hwNo");
  var hwDate    = $("hwDate");
  var hwTitle   = $("hwTitle");
  var hwBody    = $("hwBody");
  var hwScroll  = $("hwScroll");

  /* ============================ 状态 ============================ */

  var state = {
    works: [],
    drawerSize: 10,
    source: "empty",
    current: null,
    busy: false,
    torn: false,
    dragging: false,
    startX: 0,
    dragDistance: 0,
    stripWidth: 0
  };

  /* ============================ 小工具 ============================ */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function wait(ms) {
    return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
  }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  var MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
                "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];

  function formatDate(v) {
    if (!v) return "";
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (!m) return v;
    return MONTHS[Number(m[2]) - 1] + " " + m[3] + ", " + m[1];
  }

  /* ============================ HTML 清洗 ============================ */
  /* content.html 是发布工具生成的（已经清洗过），这里再走一遍白名单，
     防止有人手工改坏了目录文件后往页面里塞脚本。 */

  var ALLOWED_TAG = {
    H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
    P: 1, BLOCKQUOTE: 1,
    STRONG: 1, B: 1, EM: 1, I: 1, U: 1, S: 1, DEL: 1, SUP: 1, SUB: 1,
    UL: 1, OL: 1, LI: 1, BR: 1, HR: 1,
    A: 1, IMG: 1,
    TABLE: 1, THEAD: 1, TBODY: 1, TFOOT: 1, TR: 1, TH: 1, TD: 1
  };

  var DROP_TAG = {
    SCRIPT: 1, STYLE: 1, IFRAME: 1, OBJECT: 1, EMBED: 1,
    LINK: 1, META: 1, NOSCRIPT: 1, TEMPLATE: 1,
    FORM: 1, INPUT: 1, BUTTON: 1, TEXTAREA: 1, SELECT: 1
  };

  var SAFE_IMG = /^data:image\/(?:png|jpe?g|gif|webp|bmp|svg\+xml);base64,[a-z0-9+/=\s]+$/i;
  var SAFE_LINK = /^(?:https?:\/\/|mailto:)/i;

  function sanitizeHtml(rawHtml) {
    var tpl = document.createElement("template");
    tpl.innerHTML = rawHtml;

    var out = document.createDocumentFragment();
    Array.prototype.forEach.call(tpl.content.childNodes, function (node) {
      copyNode(node, out);
    });

    var box = document.createElement("div");
    box.appendChild(out);
    return box.innerHTML;
  }

  function copyNode(node, parent) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue) parent.appendChild(document.createTextNode(node.nodeValue));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    var tag = node.tagName.toUpperCase();
    if (DROP_TAG[tag]) return;

    if (!ALLOWED_TAG[tag]) {
      Array.prototype.forEach.call(node.childNodes, function (child) {
        copyNode(child, parent);
      });
      return;
    }

    var copy = document.createElement(tag.toLowerCase());

    if (tag === "A") {
      var href = (node.getAttribute("href") || "").trim();
      if (SAFE_LINK.test(href)) {
        copy.setAttribute("href", href);
        copy.setAttribute("target", "_blank");
        copy.setAttribute("rel", "noopener noreferrer");
      }
    }

    if (tag === "IMG") {
      var src = (node.getAttribute("src") || "").trim();
      if (!SAFE_IMG.test(src)) return;
      copy.setAttribute("src", src);
      var alt = node.getAttribute("alt");
      if (alt) copy.setAttribute("alt", alt);
    }

    Array.prototype.forEach.call(node.childNodes, function (child) {
      copyNode(child, copy);
    });
    parent.appendChild(copy);
  }

  /* ============================ 读取目录 ============================ */

  function loadWorks() {
    // file:// 下 fetch 必然被 CORS 拦掉，直接进示例模式，别在控制台刷红字
    if (window.location.protocol === "file:") {
      return Promise.resolve({ source: "demo", works: DEMO_WORKS.slice(), drawerSize: 3 });
    }

    return fetch(WORKS_URL, { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) {
          return { source: res.status === 404 ? "empty" : "error", works: [], drawerSize: 10 };
        }
        return res.json().then(function (data) {
          var works = Array.isArray(data.works) ? data.works.filter(function (w) {
            return w && w.number;
          }) : [];
          works.sort(function (a, b) {
            return String(a.number).localeCompare(String(b.number));
          });
          return {
            source: "file",
            works: works,
            drawerSize: Number(data.drawerSize) || 10
          };
        });
      })
      .catch(function () {
        // file:// 下 fetch 直接抛错 —— 用示例数据让柜子可用
        return { source: "demo", works: DEMO_WORKS.slice(), drawerSize: 3 };
      });
  }

  /** 取一篇作品的正文 HTML */
  function loadContent(work) {
    if (work.bodyHtml) return Promise.resolve(work.bodyHtml);
    if (!work.contentFile) return Promise.resolve("");

    return fetch(work.contentFile, { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.text();
      })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, "text/html");
        var body = doc.getElementById("work-body");
        return body ? body.innerHTML : html;
      })
      .catch(function (err) {
        console.error("[archive] 读取正文失败:", work.contentFile, err);
        return "";
      });
  }

  /* ============================ 档案柜 ============================ */

  function buildTab(work) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "work-tab";

    btn.appendChild(el("span", "work-no", work.number || ""));
    btn.appendChild(el("span", "work-title", work.title || "无标题"));
    btn.appendChild(el("span", "work-form",
      work.form === "book" ? "book · 小册子" : "letter · 信纸"));

    btn.addEventListener("click", function () { openWork(work); });
    return btn;
  }

  function buildDrawer(items, index) {
    var wrap = el("div", "drawer");

    var face = document.createElement("button");
    face.type = "button";
    face.className = "drawer-face";
    face.setAttribute("aria-expanded", "false");

    face.appendChild(el("span", "drawer-plate", "第 " + pad2(index + 1) + " 抽屉"));
    face.appendChild(el("span", "drawer-meta", items.length + " 篇"));

    var handle = el("span", "drawer-handle");
    handle.setAttribute("aria-hidden", "true");
    face.appendChild(handle);

    var tray = el("div", "drawer-tray");
    var list = el("ul", "work-list");

    items.forEach(function (work) {
      var li = document.createElement("li");
      li.appendChild(buildTab(work));
      list.appendChild(li);
    });

    tray.appendChild(list);
    wrap.appendChild(face);
    wrap.appendChild(tray);

    face.addEventListener("click", function () { toggleDrawer(wrap); });

    return wrap;
  }

  function toggleDrawer(drawer) {
    var tray = drawer.querySelector(".drawer-tray");
    var face = drawer.querySelector(".drawer-face");
    var open = drawer.classList.toggle("is-open");

    face.setAttribute("aria-expanded", open ? "true" : "false");
    tray.style.maxHeight = open ? tray.scrollHeight + "px" : "0px";
  }

  function openDrawer(drawer, instant) {
    var tray = drawer.querySelector(".drawer-tray");
    var face = drawer.querySelector(".drawer-face");

    drawer.classList.add("is-open");
    face.setAttribute("aria-expanded", "true");

    if (instant) tray.style.transition = "none";
    tray.style.maxHeight = tray.scrollHeight + "px";
    if (instant) {
      void tray.offsetHeight;
      tray.style.transition = "";
    }
  }

  function renderCabinet() {
    cabinetBody.replaceChildren();

    if (!state.works.length) {
      cabinetBody.appendChild(el("p", "cabinet-empty",
        "档案柜目前是空的。\n用 admin/upload.html 录入并发布作品后，这里会出现第一个抽屉。"));
      return;
    }

    var size = state.drawerSize || 10;
    var drawers = [];
    for (var i = 0; i < state.works.length; i += size) {
      drawers.push(state.works.slice(i, i + size));
    }

    drawers.forEach(function (items, index) {
      cabinetBody.appendChild(buildDrawer(items, index));
    });

    // 默认拉开第一个抽屉，让人一眼看到作品
    var first = cabinetBody.querySelector(".drawer");
    if (first) openDrawer(first, true);
  }

  function showDemoNotice() {
    var p = el("p", "cabinet-notice");
    p.appendChild(document.createTextNode(
      "示例模式：直接双击打开文件时，浏览器不允许读取 data/works.json，" +
      "下面展示的是内置示例作品。部署到 GitHub Pages，或在项目目录运行 "));
    var code = el("code", null, "python3 -m http.server");
    p.appendChild(code);
    p.appendChild(document.createTextNode(" 后访问，就会显示真实作品。"));
    cabinetBody.insertBefore(p, cabinetBody.firstChild);
  }

  /* ============================ 打开阅读 ============================ */

  function openWork(work) {
    if (state.busy) return;
    state.current = work;

    if (work.form === "book") openBook(work);
    else openLetter(work);
  }

  function showReader() {
    reader.hidden = false;
    document.body.style.overflow = "hidden";
    void reader.offsetWidth;          // 强制重排，让上抽动画能触发
    reader.classList.add("is-out");
  }

  function openLetter(work) {
    letterScene.hidden = false;
    bookScene.hidden = true;

    envNumber.textContent = work.number || "—";
    envTitle.textContent = work.title || "无标题";
    var year = (work.date || "").slice(0, 4);
    stampYear.textContent = year || String(new Date().getFullYear());

    hwNo.textContent = work.number ? "No. " + work.number : "";
    hwDate.textContent = formatDate(work.date);
    hwTitle.textContent = work.title || "无标题";
    hwBody.replaceChildren(el("p", null, "正在取出正文…"));

    resetScene();
    readerHint.textContent = "拖动封条，拆开这封信";
    showReader();

    loadContent(work).then(function (html) {
      hwBody.replaceChildren();
      if (!html) {
        hwBody.appendChild(el("p", null, "这篇作品的正文文件没有找到，无法显示内容。"));
        return;
      }
      var tpl = document.createElement("template");
      tpl.innerHTML = sanitizeHtml(html);
      hwBody.appendChild(tpl.content);
    });
  }

  function openBook(work) {
    letterScene.hidden = true;
    bookScene.hidden = false;

    bookCaption.textContent = (work.number ? work.number + " · " : "") + (work.title || "无标题");
    bookMount.replaceChildren(el("p", null, "正在取出小册子…"));
    readerHint.textContent = "点击书页或按钮翻页";
    showReader();

    loadContent(work).then(function (html) {
      bookMount.replaceChildren();

      if (!html) {
        bookMount.appendChild(el("p", null, "这篇作品的正文文件没有找到，无法显示内容。"));
        return;
      }

      if (!window.ArchivePreview) {
        bookMount.appendChild(el("p", null, "书页组件没有加载成功。"));
        return;
      }

      window.ArchivePreview.render(bookMount, {
        bodyHtml: sanitizeHtml(html),
        title: work.title || "",
        number: work.number || "",
        date: work.date || "",
        form: "book"
      });
    });
  }

  function closeReader() {
    if (reader.hidden) return;

    reader.classList.remove("is-out");
    document.body.style.overflow = "";

    window.setTimeout(function () {
      reader.hidden = true;

      if (window.ArchivePreview) window.ArchivePreview.destroy();
      bookMount.replaceChildren();
      resetScene();

      state.current = null;
      state.busy = false;
    }, 680);
  }

  /* ============================ 信封与封条 ============================ */

  function createStrip() {
    var old = document.getElementById("tearStrip");
    if (old) old.remove();

    var strip = document.createElement("div");
    strip.className = "tear-strip";
    strip.id = "tearStrip";
    strip.appendChild(el("span", null, "OPEN WITH CARE"));

    strip.addEventListener("pointerdown", onStripDown);
    strip.addEventListener("pointermove", onStripMove);
    strip.addEventListener("pointerup", onStripUp);
    strip.addEventListener("pointercancel", onStripCancel);

    letterScene.appendChild(strip);
    return strip;
  }

  function onStripDown(e) {
    if (state.torn || !state.current) return;

    var strip = e.currentTarget;
    state.dragging = true;
    state.startX = e.clientX;
    state.stripWidth = strip.getBoundingClientRect().width;
    state.dragDistance = 0;

    document.body.classList.add("is-dragging");
    strip.setPointerCapture(e.pointerId);
  }

  function onStripMove(e) {
    if (!state.dragging || state.torn) return;

    var distance = Math.max(0, Math.min(e.clientX - state.startX, state.stripWidth * 0.8));
    state.dragDistance = distance;
    e.currentTarget.style.setProperty("--drag-x", distance + "px");
  }

  function onStripUp(e) {
    if (!state.dragging || state.torn) return;

    state.dragging = false;
    document.body.classList.remove("is-dragging");

    var strip = e.currentTarget;

    if (state.dragDistance / state.stripWidth >= TEAR_PROGRESS) {
      finishTear(strip);
    } else {
      springBack(strip);
    }
  }

  function onStripCancel(e) {
    if (!state.dragging) return;
    state.dragging = false;
    document.body.classList.remove("is-dragging");
    springBack(e.currentTarget);
  }

  function springBack(strip) {
    strip.animate(
      [
        { transform: "translateX(" + state.dragDistance + "px)" },
        { transform: "translateX(-8px)" },
        { transform: "translateX(0px)" }
      ],
      { duration: 420, easing: "cubic-bezier(.34,1.56,.64,1)" }
    );

    strip.style.setProperty("--drag-x", "0px");
    state.dragDistance = 0;
  }

  /** 生成锯齿撕口（固定随机种子，每次形状一致） */
  function createTearShape() {
    var seed = 11;
    function random() {
      seed = seed * 16807 % 2147483647;
      return (seed - 1) / 2147483646;
    }

    var points = ["0% 0%", "0% 100%"];
    var count = 60;

    for (var i = 0; i <= count; i++) {
      var x = (i / count) * 100;
      var arc = i % 4 < 2 ? 3 : 10;
      var y = Math.min(100, arc + random() * 3);
      points.push(x + "% " + y + "%");
    }

    points.push("100% 100%", "100% 0%");
    return "polygon(" + points.join(",") + ")";
  }

  function finishTear(strip) {
    if (state.busy || state.torn) return;

    state.torn = true;
    state.busy = true;

    envelopeFront.style.setProperty("--tear-shape", createTearShape());
    envelopeFront.classList.add("torn");
    strip.classList.add("torn");

    var animation = strip.animate(
      [
        {
          transform: "translate(" + state.dragDistance + "px, 0) rotate(0deg)",
          opacity: 1
        },
        {
          transform: "translate(" + (state.stripWidth * 0.824) + "px, " +
                     (-state.stripWidth * 0.229) + "px) rotate(25deg)",
          opacity: 0
        }
      ],
      { duration: 700, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" }
    );

    animation.finished
      .then(function () {
        strip.remove();
        return wait(250);
      })
      .then(function () {
        envelopeFront.classList.add("opened");   // 信封正面下移
        return wait(380);
      })
      .then(function () {
        hwSheet.classList.add("is-out");         // 提高层级
        return wait(60);
      })
      .then(function () {
        hwSheet.classList.add("is-extracted");   // 信纸升起
        return wait(900);
      })
      .then(function () {
        hwSheet.classList.add("is-unfolded");    // 三折展开，解锁滚动
        readerHint.textContent = "下滑阅读 · 读完后可放回抽屉";
        state.busy = false;
      });
  }

  function resetScene() {
    state.torn = false;
    state.dragging = false;
    state.dragDistance = 0;

    envelopeFront.classList.remove("torn", "opened");
    envelopeFront.style.removeProperty("--tear-shape");

    hwSheet.classList.remove("is-out", "is-extracted", "is-unfolded");
    hwScroll.scrollTop = 0;

    createStrip();
  }

  /* ============================ 事件与启动 ============================ */

  readerClose.addEventListener("click", closeReader);

  reader.addEventListener("click", function (e) {
    if (e.target && e.target.getAttribute && e.target.getAttribute("data-close")) {
      closeReader();
    }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !reader.hidden) closeReader();
  });

  loadWorks().then(function (result) {
    state.works = result.works;
    state.drawerSize = result.drawerSize;
    state.source = result.source;

    statusEl.classList.remove("is-error");

    if (result.source === "demo") {
      statusEl.textContent = "示例模式 · 未能读取 data/works.json";
    } else if (result.source === "empty") {
      statusEl.textContent = "档案柜暂时是空的";
    } else if (result.source === "error") {
      statusEl.textContent = "作品目录读取失败";
      statusEl.classList.add("is-error");
    } else {
      statusEl.textContent = "";
    }

    renderCabinet();
    if (result.source === "demo") showDemoNotice();

    countEl.textContent = state.works.length ? " · " + state.works.length + " 篇作品" : "";
  }).catch(function (err) {
    // 兜底：任何意外都别让页面一直停在「正在打开档案柜…」
    console.error("[archive] 初始化失败", err);
    statusEl.textContent = "档案柜加载失败：" + ((err && err.message) || "未知错误");
    statusEl.classList.add("is-error");
  });
})();
