/* ==========================================================================
   admin/preview.js
   第二阶段：自动提取标题 + 阅读预览

   两种阅读形式：
     letter —— 三折信纸，展开后可以下滑继续阅读（长信）
     book   —— 小册子，内容自动分页，可以一页一页翻

   设计要点：
     · 正文 HTML 在 upload.js 里已经过白名单清洗，这里只做 DOM 移动与克隆，
       绝不把字符串交给 innerHTML 去解析用户内容。
     · 信纸的“三折”是盖在正文上的一层封面：上、中、下三条折页分别绕折痕
       旋转飞开，露出底下的完整信纸；信纸本身是一个可滚动的长卷。
     · 小册子用 Range 做分页（可以跨页拆分长段落，并保留粗体/斜体），
       翻页是一片绕书脊旋转的“纸叶”，正面是当前右页、背面是下一张左页。
   ========================================================================== */

(function (global) {
  "use strict";

  /* ============================ 小工具 ============================ */

  var MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
                "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function templateOf(html) {
    var t = document.createElement("template");
    t.innerHTML = html;           // 内容是已清洗过的，template 也不会执行脚本
    return t;
  }

  function cleanText(s) {
    return (s || "").replace(/\s+/g, " ").trim();
  }

  function isBlankText(n) {
    return n.nodeType === 3 && !n.nodeValue.trim();
  }

  /** 取第一个“有意义”的子节点，跳过空白文本和空元素 */
  function firstMeaningful(parent) {
    for (var n = parent.firstChild; n; n = n.nextSibling) {
      if (isBlankText(n)) continue;
      if (n.nodeType === 1 && !n.textContent.trim() && !n.querySelector("img")) continue;
      return n;
    }
    return null;
  }

  function serialize(fragment) {
    var box = document.createElement("div");
    box.appendChild(fragment.cloneNode(true));
    return box.innerHTML;
  }

  function formatDate(v) {
    if (!v) return "";
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (!m) return v;
    return MONTHS[Number(m[2]) - 1] + " " + m[3] + ", " + m[1];
  }

  function appendClones(target, nodes) {
    nodes.forEach(function (n) { target.appendChild(n.cloneNode(true)); });
  }

  /* ============================ 标题提取 ============================ */

  /**
   * 从正文里提取作品标题。
   * 规则：正文第一个有意义的元素必须是 h1~h3，且文字不超过 120 字。
   * 命中后把这个标题从正文里移除，避免预览时标题重复出现。
   * 不命中就返回空标题，由调用方回退到文件名。
   */
  function extractTitle(bodyHtml) {
    var tpl = templateOf(bodyHtml);
    var first = firstMeaningful(tpl.content);

    if (first && first.nodeType === 1 && /^H[1-3]$/.test(first.tagName)) {
      var text = cleanText(first.textContent);
      if (text && text.length <= 120) {
        first.parentNode.removeChild(first);
        return { title: text, bodyHtml: serialize(tpl.content) };
      }
    }
    return { title: "", bodyHtml: bodyHtml };
  }

  /* ============================ 信纸预览 ============================ */

  function renderLetter(mount, data) {
    var reader = el("div", "letter-reader");
    var stage = el("div", "letter-stage");

    /* --- 信纸本体：信头 + 可滚动正文 --- */
    var sheet = el("article", "letter-sheet");

    var head = el("header", "letter-head");
    var metaRow = el("div", "letter-meta");
    var noEl = el("span", "letter-no");
    var dateEl = el("span", "letter-date");
    metaRow.appendChild(noEl);
    metaRow.appendChild(dateEl);
    head.appendChild(metaRow);
    var titleEl = el("h3", "letter-title");
    head.appendChild(titleEl);
    sheet.appendChild(head);

    /** 只刷新信头文字，不重绘整封信（打字时不会打断阅读位置） */
    function setHead(meta) {
      titleEl.textContent = meta.title || "无标题";
      noEl.textContent = meta.number ? "No. " + meta.number : "";
      dateEl.textContent = meta.date ? formatDate(meta.date) : "";
      noEl.hidden = !meta.number;
      dateEl.hidden = !meta.date;
    }
    setHead(data);

    var scroll = el("div", "letter-scroll");
    scroll.tabIndex = 0;
    var body = el("div", "doc-body letter-body");
    appendClones(body, data.nodes);
    scroll.appendChild(body);
    scroll.appendChild(el("p", "letter-end", "— 完 —"));
    sheet.appendChild(scroll);

    stage.appendChild(sheet);

    /* --- 三折封面 --- */
    var cover = el("div", "fold-cover");
    cover.tabIndex = 0;
    cover.setAttribute("role", "button");
    cover.setAttribute("aria-label", "展开信纸阅读");

    ["top", "mid", "bot"].forEach(function (k) {
      var panel = el("div", "fold-panel fold-panel--" + k);
      if (k === "mid") {
        panel.appendChild(el("span", "fold-seal", "OPEN WITH CARE"));
        panel.appendChild(el("span", "fold-hint", "点击展开"));
      }
      cover.appendChild(panel);
    });
    stage.appendChild(cover);

    /* --- 下滑提示 --- */
    var hint = el("div", "scroll-hint", "↓ 下滑继续阅读");
    stage.appendChild(hint);

    reader.appendChild(stage);

    /* --- 操作条 --- */
    var actions = el("div", "reader-actions");
    var btn = el("button", "reader-btn", "展开信纸");
    btn.type = "button";
    actions.appendChild(btn);
    reader.appendChild(actions);

    mount.appendChild(reader);

    /* --- 交互 --- */
    var opened = false;

    function setOpen(v) {
      opened = v;
      reader.classList.toggle("is-open", v);
      cover.setAttribute("aria-hidden", v ? "true" : "false");
      cover.tabIndex = v ? -1 : 0;
      btn.textContent = v ? "重新折叠" : "展开信纸";
      if (!v) {
        scroll.scrollTop = 0;
        hint.classList.remove("is-gone");
      }
    }

    btn.addEventListener("click", function () { setOpen(!opened); });

    cover.addEventListener("click", function () { if (!opened) setOpen(true); });
    cover.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        if (!opened) setOpen(true);
      }
    });

    scroll.addEventListener("scroll", function () {
      if (scroll.scrollTop > 24) hint.classList.add("is-gone");
    }, { passive: true });

    return { type: "letter", rerender: null, updateMeta: setHead };
  }

  /* ============================ 小册子预览 ============================ */

  /* ---- 分页核心 ---- */

  /** 找到第 index 个字符所在的文本节点与偏移 */
  function locate(root, index) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var acc = 0, node;
    while ((node = walker.nextNode())) {
      var len = node.nodeValue.length;
      if (acc + len >= index) return { node: node, offset: index - acc };
      acc += len;
    }
    return { node: root, offset: root.childNodes.length };
  }

  /** 截取 [start, end) 之间的内容，保留内部的粗体/斜体等行内标签 */
  function sliceBlock(block, start, end) {
    var holder = block.cloneNode(false);
    var range = document.createRange();
    range.selectNodeContents(block);

    if (end != null) {
      var b = locate(block, end);
      range.setEnd(b.node, b.offset);
    }
    if (start > 0) {
      var a = locate(block, start);
      range.setStart(a.node, a.offset);
    }

    holder.appendChild(range.cloneContents());
    return holder;
  }

  /** 在 space 附近断句，避免把单词劈开 */
  function boundaryCut(text, n) {
    for (var i = n; i > Math.max(0, n - 40); i--) {
      if (/\s/.test(text.charAt(i))) return i + 1;
    }
    return n;
  }

  /**
   * 把一个“单独就超过一页”的块，按字符二分切成若干页。
   * 只对段落类元素生效；图片、表格这类不可切分的返回空数组。
   */
  function splitBlock(block, height, meas) {
    if (!/^(P|LI|H[1-6]|BLOCKQUOTE)$/.test(block.tagName)) return [];
    if (block.textContent.length < 30) return [];

    var parts = [];
    var rest = block.cloneNode(true);
    var guard = 0;

    while (rest && rest.textContent.trim() && guard++ < 80) {
      var len = rest.textContent.length;
      var probe = el("div", "page-flow");
      meas.appendChild(probe);

      var best = 0, lo = 1, hi = len;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        probe.replaceChildren(sliceBlock(rest, 0, mid));
        if (probe.getBoundingClientRect().height <= height + 0.5) {
          best = mid; lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      probe.remove();

      if (best <= 0) break;
      if (best >= len) { parts.push(rest); rest = null; break; }

      var cut = Math.min(boundaryCut(rest.textContent, best), best);
      parts.push(sliceBlock(rest, 0, cut));
      rest = sliceBlock(rest, cut, null);

      // 跳过剩余内容开头的空白
      while (rest.firstChild && isBlankText(rest.firstChild)) rest.removeChild(rest.firstChild);
    }

    if (rest && rest.textContent.trim()) parts.push(rest);
    return parts;
  }

  /**
   * 把正文节点流式排进固定尺寸的页面里。
   * @returns {Array<{nodes:Array, overflow:boolean}>}
   */
  function paginate(nodes, width, height) {
    var meas = el("div", "book-measure doc-body book-body");
    meas.style.width = width + "px";
    meas.style.height = height + "px";
    document.body.appendChild(meas);

    var pages = [];
    var flow = null;

    function newFlow() {
      flow = el("div", "page-flow");
      meas.appendChild(flow);
      pages.push(flow);
    }

    function flowHeight() {
      return flow.getBoundingClientRect().height;
    }

    /**
     * 当前页还有空间时，把这一块拆成“填满本页的部分 + 剩下的部分”。
     * 放不下就返回 null，让调用方另起一页。
     */
    function splitWithin(block, limit) {
      if (!/^(P|LI|H[1-6]|BLOCKQUOTE)$/.test(block.tagName)) return null;

      var total = block.textContent.length;
      if (total < 40) return null;

      var holder = block.cloneNode(false);
      flow.appendChild(holder);

      var best = 0, lo = 1, hi = total;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        holder.replaceChildren(sliceBlock(block, 0, mid));
        if (flowHeight() <= limit + 0.5) { best = mid; lo = mid + 1; }
        else { hi = mid - 1; }
      }

      flow.removeChild(holder);
      if (best <= 0 || best >= total) return null;

      var cut = Math.min(boundaryCut(block.textContent, best), best);
      if (cut <= 0 || cut >= total) return null;

      var head = sliceBlock(block, 0, cut);
      var tail = sliceBlock(block, cut, null);
      while (tail.firstChild && isBlankText(tail.firstChild)) tail.removeChild(tail.firstChild);
      if (!tail.textContent.trim()) return null;

      return [head, tail];
    }

    newFlow();

    var queue = nodes
      .filter(function (n) { return !isBlankText(n); })
      .map(function (n) { return n.cloneNode(true); });

    while (queue.length) {
      var node = queue.shift();
      flow.appendChild(node);

      if (flowHeight() <= height + 0.5) continue;

      flow.removeChild(node);

      if (flow.childNodes.length === 0) {
        // 这一块自己就放不进一页
        var parts = splitBlock(node, height, meas);
        if (parts.length > 1) {
          flow.appendChild(parts.shift());
          queue = parts.concat(queue);
          newFlow();
        } else {
          // 不可切分（图片、表格等）：独占一页并标记为可滚动
          flow.appendChild(node);
          flow.dataset.overflow = "1";
          newFlow();
        }
      } else {
        // 本页已有内容：先看能不能把这一块拆开填满剩余空间
        var remaining = height - flowHeight();
        var parts2 = remaining > height * 0.2 ? splitWithin(node, height) : null;

        if (parts2) {
          flow.appendChild(parts2[0]);
          queue.unshift(parts2[1]);
        } else {
          queue.unshift(node);
        }
        newFlow();
      }
    }

    // 丢弃末尾的空页
    while (pages.length && pages[pages.length - 1].childNodes.length === 0) {
      pages.pop().remove();
    }

    var result = pages.map(function (p) {
      return {
        nodes: Array.prototype.slice.call(p.childNodes),
        overflow: p.dataset.overflow === "1"
      };
    });

    meas.remove();
    return result;
  }

  /* ---- 渲染 ---- */

  function renderBook(mount, data) {
    var book = el("div", "book");
    var spread = el("div", "book-spread");

    var leftPage = el("div", "book-page book-page--left");
    var rightPage = el("div", "book-page book-page--right");
    var leftInner = el("div", "book-page-inner");
    var rightInner = el("div", "book-page-inner");
    leftPage.appendChild(leftInner);
    rightPage.appendChild(rightInner);

    // 翻页用的“纸叶”：正面 = 当前右页，背面 = 下一张左页
    var leaf = el("div", "book-leaf");
    leaf.hidden = true;
    var leafFront = el("div", "leaf-face leaf-face--front");
    var leafBack = el("div", "leaf-face leaf-face--back");
    var frontInner = el("div", "book-page-inner");
    var backInner = el("div", "book-page-inner");
    leafFront.appendChild(frontInner);
    leafBack.appendChild(backInner);
    leaf.appendChild(leafFront);
    leaf.appendChild(leafBack);

    spread.appendChild(leftPage);
    spread.appendChild(rightPage);
    spread.appendChild(leaf);
    book.appendChild(spread);

    var controls = el("div", "book-controls");
    var prevBtn = el("button", "book-btn", "‹ 上一页");
    var counter = el("span", "book-count");
    var nextBtn = el("button", "book-btn", "下一页 ›");
    prevBtn.type = "button";
    nextBtn.type = "button";
    controls.appendChild(prevBtn);
    controls.appendChild(counter);
    controls.appendChild(nextBtn);
    book.appendChild(controls);

    mount.appendChild(book);

    /* --- 尺寸与分页 --- */
    var available = mount.clientWidth || 720;
    var spreadMode = available >= 720;
    var bookW = Math.min(available, 980);
    var pageW = spreadMode ? Math.floor((bookW - 2) / 2) : Math.floor(bookW);
    var pageH = Math.min(
      spreadMode ? Math.round(pageW * 1.42) : Math.round(pageW * 1.34),
      620
    );

    var padX = Math.max(16, Math.round(pageW * 0.11));
    var padY = Math.max(18, Math.round(pageH * 0.085));

    book.style.setProperty("--page-w", pageW + "px");
    book.style.setProperty("--page-h", pageH + "px");
    book.classList.toggle("book--single", !spreadMode);

    [leftInner, rightInner, frontInner, backInner].forEach(function (c) {
      c.style.padding = padY + "px " + padX + "px";
    });

    var pages = paginate(data.nodes, pageW - padX * 2, pageH - padY * 2);
    var pageCount = pages.length;
    var spreadIndex = 0;
    var turning = false;

    /* --- 绘制 --- */
    function fill(container, page) {
      container.replaceChildren();
      container.classList.toggle("is-overflow", !!(page && page.overflow));
      if (!page) return;
      page.nodes.forEach(function (n) { container.appendChild(n.cloneNode(true)); });
    }

    /* 单页模式（窄屏）一屏只显示一页，跨页模式一屏显示两页 */
    var perTurn = spreadMode ? 2 : 1;

    function drawSpread() {
      if (spreadMode) {
        fill(leftInner, pages[spreadIndex * 2]);
        fill(rightInner, pages[spreadIndex * 2 + 1]);
      } else {
        fill(leftInner, null);
        fill(rightInner, pages[spreadIndex]);
      }
    }

    function drawCounter() {
      if (!pageCount) { counter.textContent = "无内容"; return; }
      var first = spreadIndex * perTurn + 1;
      var last = Math.min(first + perTurn - 1, pageCount);
      counter.textContent = (first === last ? first : first + "–" + last) + " / " + pageCount;
      prevBtn.disabled = spreadIndex <= 0;
      nextBtn.disabled = first + perTurn - 1 >= pageCount;
    }

    function done() {
      drawSpread();
      drawCounter();
      leaf.hidden = true;
      leaf.style.transition = "";
      leaf.style.transform = "";
      leaf.style.opacity = "";
      turning = false;
    }

    /* 单页模式下纸叶转开后会飞出书外，所以转角更小并淡出 */
    function endTransformForward() {
      return spreadMode ? "rotateY(-180deg)" : "rotateY(-118deg)";
    }

    /* --- 向后翻 --- */
    function turnForward() {
      if (turning) return;
      if (nextBtn.disabled) return;
      turning = true;

      var nxt = spreadIndex + 1;

      if (spreadMode) {
        fill(frontInner, pages[spreadIndex * 2 + 1]);
        fill(backInner, pages[nxt * 2]);
        fill(rightInner, pages[nxt * 2 + 1]);
      } else {
        fill(frontInner, pages[spreadIndex]);
        fill(backInner, pages[nxt]);
        fill(rightInner, pages[nxt]);
      }

      leaf.hidden = false;
      leaf.style.transition = "none";
      leaf.style.transform = "rotateY(0deg)";
      leaf.style.opacity = "1";
      void leaf.offsetWidth;                       // 强制重排，确保过渡生效

      leaf.style.transition = "";
      leaf.style.transform = endTransformForward();
      if (!spreadMode) leaf.style.opacity = "0";

      window.setTimeout(function () {
        spreadIndex = nxt;
        done();
      }, 760);
    }

    /* --- 向前翻 --- */
    function turnBackward() {
      if (turning) return;
      if (spreadIndex <= 0) return;
      turning = true;

      var prv = spreadIndex - 1;

      if (spreadMode) {
        fill(frontInner, pages[prv * 2 + 1]);
        fill(backInner, pages[spreadIndex * 2]);
        fill(rightInner, pages[prv * 2 + 1]);
      } else {
        fill(frontInner, pages[prv]);
        fill(backInner, null);
        fill(rightInner, pages[prv]);
      }

      leaf.hidden = false;
      leaf.style.transition = "none";
      leaf.style.transform = endTransformForward();
      leaf.style.opacity = spreadMode ? "1" : "0";
      void leaf.offsetWidth;

      leaf.style.transition = "";
      leaf.style.transform = "rotateY(0deg)";
      leaf.style.opacity = "1";

      window.setTimeout(function () {
        spreadIndex = prv;
        done();
      }, 760);
    }

    prevBtn.addEventListener("click", turnBackward);
    nextBtn.addEventListener("click", turnForward);

    // 点右页向后翻、点左页向前翻
    rightPage.addEventListener("click", turnForward);
    leftPage.addEventListener("click", turnBackward);

    drawSpread();
    drawCounter();

    return {
      type: "book",
      rerender: function () { renderBook(mount, data); }
    };
  }

  /* ============================ 对外接口 ============================ */

  var state = { mount: null, data: null, inst: null };
  var resizeTimer = null;

  function onResize() {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(function () {
      if (!state.mount || !state.data) return;
      // 只有小册子需要重新分页；信纸本身是自适应滚动
      if (state.inst && state.inst.type === "book") {
        render(state.mount, state.data);
      }
    }, 280);
  }

  function render(mount, data) {
    mount.replaceChildren();
    state.mount = mount;
    state.data = data;

    var nodes = Array.prototype.slice.call(templateOf(data.bodyHtml).content.childNodes)
      .filter(function (n) { return !isBlankText(n); });

    var payload = {
      nodes: nodes,
      title: data.title || "",
      number: data.number || "",
      date: data.date || ""
    };

    state.inst = data.form === "book"
      ? renderBook(mount, payload)
      : renderLetter(mount, payload);
  }

  function destroy() {
    if (state.mount) state.mount.replaceChildren();
    state.mount = null;
    state.data = null;
    state.inst = null;
  }

  window.addEventListener("resize", onResize);

  function updateMeta(meta) {
    if (state.inst && typeof state.inst.updateMeta === "function") {
      state.inst.updateMeta(meta);
    }
  }

  global.ArchivePreview = {
    extractTitle: extractTitle,
    render: render,
    updateMeta: updateMeta,
    destroy: destroy
  };

})(window);
