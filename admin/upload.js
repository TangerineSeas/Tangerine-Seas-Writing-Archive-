/* ==========================================================================
   admin/upload.js
   第一阶段：DOCX 上传、拖拽与读取
   第二阶段：自动提取标题、填写档案信息、生成阅读预览
   第三阶段：把草稿存进 IndexedDB，并管理草稿抽屉

   职责范围：
     1. 点击选择 / 拖拽投放 .docx
     2. 校验扩展名、大小、文件头
     3. 用 Mammoth.js 在浏览器端把 DOCX 转成 HTML
     4. 对转换结果做白名单清洗，再插入页面（防 XSS）
     5. 提取标题、生成档案编号，交给 preview.js 渲染预览
     6. 草稿保存 / 列表 / 打开 / 删除 / 导出备份

   不含：发布打包（第五阶段）、首页档案柜接入（第六阶段）。
   ========================================================================== */

(function () {
  "use strict";

  /* ------------------------------ 常量 ------------------------------ */

  var MAX_BYTES = 20 * 1024 * 1024; // 20 MB
  var ALLOWED_EXT = "docx";

  /* Mammoth 转换选项
     - convertImage：把文档内图片转成 data URI，随 HTML 一起保留，不静默丢弃
     - styleMap：把 Word 里的 Title / Subtitle / Quote 等样式映射为语义标签 */
  var MAMMOTH_OPTIONS = {
    convertImage: mammoth.images.dataUri,
    styleMap: [
      "p[style-name='Title'] => h1:fresh",
      "p[style-name='Subtitle'] => h3:fresh",
      "p[style-name='Quote'] => blockquote:fresh",
      "p[style-name='Intense Quote'] => blockquote:fresh"
    ]
  };

  /* HTML 清洗白名单：只允许这些标签出现在页面上 */
  var ALLOWED_TAGS = {
    H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
    P: 1, BLOCKQUOTE: 1,
    STRONG: 1, B: 1, EM: 1, I: 1, U: 1, S: 1, DEL: 1, SUP: 1, SUB: 1,
    UL: 1, OL: 1, LI: 1, BR: 1, HR: 1,
    A: 1, IMG: 1,
    TABLE: 1, THEAD: 1, TBODY: 1, TFOOT: 1, TR: 1, TH: 1, TD: 1
  };

  /* 这些标签连同内容整块丢弃（绝不保留其文本） */
  var DROP_TAGS = {
    SCRIPT: 1, STYLE: 1, IFRAME: 1, OBJECT: 1, EMBED: 1,
    LINK: 1, META: 1, NOSCRIPT: 1, TEMPLATE: 1,
    FORM: 1, INPUT: 1, BUTTON: 1, TEXTAREA: 1, SELECT: 1
  };

  /* 图片只接受内嵌的图片 data URI */
  var SAFE_IMG_SRC = /^data:image\/(?:png|jpe?g|gif|webp|bmp|svg\+xml);base64,[a-z0-9+/=\s]+$/i;
  /* 链接只接受这几种协议，杜绝 javascript: 之类 */
  var SAFE_LINK = /^(?:https?:\/\/|mailto:)/i;

  /* ------------------------------ DOM ------------------------------ */

  var $ = function (id) { return document.getElementById(id); };

  var dropzone   = $("dropzone");
  var fileInput  = $("fileInput");
  var fileCard   = $("fileCard");
  var fileNameEl = $("fileName");
  var fileSubEl  = $("fileSub");
  var statusEl   = $("statusBadge");
  var clearBtn   = $("clearBtn");
  var noticeEl   = $("notice");

  var metaPanel  = $("metaPanel");
  var titleInput = $("titleInput");
  var numberInput = $("numberInput");
  var dateInput  = $("dateInput");
  var formButtons = Array.prototype.slice.call(document.querySelectorAll(".choice"));
  var saveBtn    = $("saveBtn");
  var saveState  = $("saveState");

  var previewEl  = $("preview");
  var previewMount = $("previewMount");
  var statsEl    = $("stats");
  var docBody    = $("docBody");

  var draftList  = $("draftList");
  var drawerEmpty = $("drawerEmpty");
  var drawerCount = $("drawerCount");
  var drawerNotice = $("drawerNotice");
  var exportAllBtn = $("exportAllBtn");
  var importBtn  = $("importBtn");
  var importInput = $("importInput");

  var publishBtn = $("publishBtn");
  var publishResult = $("publishResult");
  var publishTitle = $("publishTitle");
  var publishBody  = $("publishBody");

  var ghPanel      = $("ghPanel");
  var ghState      = $("ghState");
  var ghOwner      = $("ghOwner");
  var ghRepo       = $("ghRepo");
  var ghBranch     = $("ghBranch");
  var ghToken      = $("ghToken");
  var ghConnectBtn = $("ghConnectBtn");
  var ghDisconnectBtn = $("ghDisconnectBtn");
  var ghHint       = $("ghHint");

  /* ------------------------------ 状态 ------------------------------ */

  var busy = false;      // 正在读取时禁止重复触发
  var dragDepth = 0;     // 拖拽进入/离开计数，避免子元素导致闪烁

  var ghConfig = null;   // GitHub 连接配置（令牌只在本地保存）

  var state = {
    bodyHtml: "",        // 清洗后的正文 HTML
    title: "",
    number: "",
    date: "",
    form: "letter",

    // 草稿相关
    draftId: null,       // 当前草稿 ID；null 表示尚未保存
    createdAt: 0,        // 草稿创建时间（更新时保留原值）
    file: null,          // 原始 DOCX（File 或 Blob）
    fileName: "",
    fileType: "",
    fileSize: 0,
    dirty: false         // 是否有未保存的修改
  };

  /* ============================ 小工具 ============================ */

  function formatBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(2) + " MB";
  }

  /** 取小写扩展名（不含点） */
  function extOf(name) {
    var i = (name || "").lastIndexOf(".");
    return i === -1 ? "" : name.slice(i + 1).toLowerCase();
  }

  /** 构造一条「可以直接给用户看」的错误 */
  function userError(message) {
    var err = new Error(message);
    err.userMessage = message;
    return err;
  }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function ymd(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  /** 列表里的时间：今天显示「今天 14:22」，否则「11月3日 14:22」 */
  function formatWhen(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    var now = new Date();
    var hm = pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return "今天 " + hm;
    return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + hm;
  }

  /** 标题兜底：用文件名，去掉扩展名并把下划线/连字符还原成空格 */
  function titleFromFilename(name) {
    return (name || "")
      .replace(/\.[^.]+$/, "")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * 生成档案编号：TS-YYYYMMDD-NN
   * 序号按「同一天第几次录入」自增，存在 localStorage；
   * 拿不到 localStorage 就退回 01。编号随时可以手动改。
   */
  function nextArchiveNumber() {
    var today = ymd(new Date());
    var seq = 1;
    try {
      var raw = window.localStorage.getItem("ts.archive.seq");
      var prev = raw ? JSON.parse(raw) : null;
      if (prev && prev.day === today && typeof prev.n === "number") {
        seq = prev.n + 1;
      }
      window.localStorage.setItem("ts.archive.seq", JSON.stringify({ day: today, n: seq }));
    } catch (e) {
      seq = 1; // 隐私模式等情况下 localStorage 不可用
    }
    return "TS-" + today.replace(/-/g, "") + "-" + pad2(seq);
  }

  /* ============================ 界面反馈 ============================ */

  function setStatus(kind, text) {
    statusEl.className = "status status--" + kind;
    statusEl.textContent = text;
  }

  /** 提示条。用 textContent 写入，避免任何 HTML 注入 */
  function showNotice(kind, text) {
    noticeEl.className = "notice notice--" + kind;
    noticeEl.textContent = text;
    noticeEl.hidden = false;
  }

  function hideNotice() {
    noticeEl.hidden = true;
    noticeEl.textContent = "";
  }

  function showFileCard(name, size, type) {
    fileNameEl.textContent = name || "（无原始文件）";
    fileSubEl.textContent = (size ? formatBytes(size) : "—") + " · " + (type || "未知类型");
    fileCard.hidden = false;
  }

  function resetView() {
    metaPanel.hidden = true;
    previewEl.hidden = true;
    statsEl.replaceChildren();
    docBody.replaceChildren();
    if (window.ArchivePreview) window.ArchivePreview.destroy();
  }

  function setSaveState(text, kind) {
    saveState.textContent = text || "";
    saveState.className = "save-state" + (kind ? " save-state--" + kind : "");
  }

  function markDirty() {
    state.dirty = true;
    setSaveState("有未保存的修改", "dirty");
  }

  /* ============================ 文件校验 ============================ */

  function validateFile(file) {
    if (!file) return { ok: false, message: "没有拿到文件，请重新选择。" };

    var ext = extOf(file.name);

    if (ext === "doc") {
      return {
        ok: false,
        message:
          "这是旧版 .doc 格式，暂不支持。\n" +
          "请用 Word 打开后「另存为 → Word 文档 (.docx)」，再重新上传。"
      };
    }

    if (ext !== ALLOWED_EXT) {
      return {
        ok: false,
        message: "只接受 .docx 文件。当前文件是「" +
                 (ext ? "." + ext : "无扩展名") + "」。"
      };
    }

    if (file.size === 0) {
      return { ok: false, message: "文件是空的（0 字节），可能没有保存成功。" };
    }

    if (file.size > MAX_BYTES) {
      return {
        ok: false,
        message: "文件 " + formatBytes(file.size) +
                 "，超过 20 MB 上限。请精简图片或拆分文档后再上传。"
      };
    }

    return { ok: true };
  }

  /**
   * 检查文件头，识别「改了扩展名的 .doc」和「加了密码的 DOCX」。
   * DOCX 本质是 ZIP（以 PK 开头）；旧版 .doc 与加密后的 OOXML 都是 OLE 容器。
   */
  async function checkSignature(file) {
    var head = new Uint8Array(await file.slice(0, 8).arrayBuffer());

    var isZip =
      head[0] === 0x50 && head[1] === 0x4B &&
      (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07);

    var isOle =
      head[0] === 0xD0 && head[1] === 0xCF &&
      head[2] === 0x11 && head[3] === 0xE0;

    if (isOle) {
      throw userError(
        "这个文件不是标准的 DOCX 包。\n" +
        "它可能是旧版 Word 97-2003 的 .doc（只是扩展名被改成了 .docx），" +
        "也可能是设置了打开密码的 DOCX —— 加密后的文档会被包成 OLE 容器。\n" +
        "请用 Word 打开、取消密码后「另存为 .docx」再试。"
      );
    }

    if (!isZip) {
      throw userError(
        "文件内容不是有效的 DOCX（ZIP）结构，可能已经损坏，或扩展名与实际格式不符。"
      );
    }
  }

  /* ============================ HTML 清洗 ============================ */

  /**
   * 按白名单重建 DOM，返回干净的 DocumentFragment。
   * 不依赖 innerHTML 的二次解析，避免残留属性或事件。
   */
  function sanitizeHtml(rawHtml) {
    var template = document.createElement("template");
    template.innerHTML = rawHtml; // template 内的内容不会执行脚本

    var out = document.createDocumentFragment();
    var dropped = { images: 0, links: 0 };

    Array.prototype.forEach.call(template.content.childNodes, function (node) {
      copyNode(node, out, dropped);
    });

    return { fragment: out, dropped: dropped };
  }

  function copyNode(node, parentOut, dropped) {
    // 文本节点：直接复制
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue) parentOut.appendChild(document.createTextNode(node.nodeValue));
      return;
    }

    // 只处理元素节点，注释等一律跳过
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    var tag = node.tagName.toUpperCase();

    // 危险标签：连内容一起丢掉
    if (DROP_TAGS[tag]) return;

    // 不在白名单：解包，只保留其中的文字/子节点
    if (!ALLOWED_TAGS[tag]) {
      Array.prototype.forEach.call(node.childNodes, function (child) {
        copyNode(child, parentOut, dropped);
      });
      return;
    }

    var el = document.createElement(tag.toLowerCase());

    // 只复制白名单内的属性
    if (tag === "A") {
      var href = (node.getAttribute("href") || "").trim();
      if (SAFE_LINK.test(href)) {
        el.setAttribute("href", href);
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      } else {
        dropped.links++;
      }
    }

    if (tag === "IMG") {
      var src = (node.getAttribute("src") || "").trim();
      if (SAFE_IMG_SRC.test(src)) {
        el.setAttribute("src", src);
      } else {
        dropped.images++;
        return;
      }
      var alt = node.getAttribute("alt");
      if (alt) el.setAttribute("alt", alt);
    }

    Array.prototype.forEach.call(node.childNodes, function (child) {
      copyNode(child, el, dropped);
    });

    parentOut.appendChild(el);
  }

  /* ============================ 读取流程 ============================ */

  async function readDocx(file) {
    var arrayBuffer = await file.arrayBuffer();
    return mammoth.convertToHtml({ arrayBuffer: arrayBuffer }, MAMMOTH_OPTIONS);
  }

  /** 把 Mammoth 抛出的原始错误翻译成人话 */
  function describeError(err) {
    if (err && err.userMessage) return err.userMessage;

    var raw = err && err.message ? String(err.message) : String(err);

    if (/password|encrypt/i.test(raw)) {
      return "这个 DOCX 似乎设置了密码保护，无法读取。请先在 Word 中取消密码保护再上传。";
    }
    if (/end of data|invalid|corrupt|central directory|zip/i.test(raw)) {
      return "无法解析这个 DOCX，文件可能已损坏。\n技术信息：" + raw;
    }
    return "读取失败。\n技术信息：" + raw;
  }

  /**
   * 主入口：处理用户选中的文件。
   */
  async function handleFile(file) {
    if (busy) return;

    if (state.dirty && !window.confirm("当前草稿还有未保存的修改，确定要换一份新文稿吗？")) {
      return;
    }

    hideNotice();
    resetView();

    // ---- 1. 基础校验 ----
    var check = validateFile(file);
    if (!check.ok) {
      showFileCard(file.name, file.size, file.type);
      setStatus("error", "格式不符");
      showNotice("error", check.message);
      return;
    }

    busy = true;
    dropzone.classList.add("is-busy");
    showFileCard(file.name, file.size, file.type);
    setStatus("reading", "读取中");

    try {
      // ---- 2. 文件头校验 ----
      await checkSignature(file);

      // ---- 3. DOCX → HTML ----
      var result = await readDocx(file);

      if (!result.value || !result.value.trim()) {
        throw userError("这个文档里没有可读取的正文内容（可能是空白文档，或内容都在文本框/页眉里）。");
      }

      // ---- 4. 清洗后取 HTML 字符串 ----
      var clean = sanitizeHtml(result.value);
      var holder = document.createElement("div");
      holder.appendChild(clean.fragment.cloneNode(true));
      var bodyHtml = holder.innerHTML;

      // ---- 5. 提取标题（失败则回退文件名） ----
      var ex = window.ArchivePreview.extractTitle(bodyHtml);
      state.bodyHtml = ex.bodyHtml;
      state.title = ex.title || titleFromFilename(file.name);

      // ---- 6. 档案信息默认值 ----
      state.number = nextArchiveNumber();
      state.date = ymd(new Date());

      // ---- 7. 这是一份新文稿，清掉上一条草稿的关联 ----
      state.draftId = null;
      state.createdAt = 0;
      state.file = file;
      state.fileName = file.name;
      state.fileType = file.type;
      state.fileSize = file.size;

      // ---- 8. 填充表单 ----
      titleInput.value = state.title;
      numberInput.value = state.number;
      dateInput.value = state.date;
      syncFormButtons();
      saveBtn.textContent = "保存草稿";

      // 供统计使用（内容已清洗）
      var tpl = document.createElement("template");
      tpl.innerHTML = state.bodyHtml;
      docBody.replaceChildren(tpl.content);

      // ---- 9. 显示并渲染预览 ----
      metaPanel.hidden = false;
      previewEl.hidden = false;

      renderStats();
      renderPreview();
      markDirty();

      setStatus("done", "已读取");

      // 转换过程中的提示（图片缺失等）如实告知
      var messages = (result.messages || []).filter(function (m) {
        return m.type === "warning" || m.type === "error";
      });
      var notes = [];
      if (messages.length) {
        notes.push("转换时有 " + messages.length + " 条提示：\n" +
          messages.slice(0, 3).map(function (m) {
            return "· " + m.message;
          }).join("\n"));
      }
      if (clean.dropped.images) {
        notes.push("· 有 " + clean.dropped.images + " 张图片未能保留（不是可内嵌的图片格式）。");
      }
      if (clean.dropped.links) {
        notes.push("· 有 " + clean.dropped.links + " 个链接因协议不受支持已被移除。");
      }
      if (notes.length) showNotice("warn", notes.join("\n\n"));

      metaPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (err) {
      setStatus("error", "读取失败");
      showNotice("error", describeError(err));
      console.error("[upload] 读取 DOCX 失败：", err);
    } finally {
      busy = false;
      dropzone.classList.remove("is-busy");
    }
  }

  /* ============================ 预览与档案信息 ============================ */

  function renderPreview() {
    window.ArchivePreview.render(previewMount, {
      bodyHtml: state.bodyHtml,
      title: state.title,
      number: state.number,
      date: state.date,
      form: state.form
    });
  }

  /** 把表单当前值同步进 state */
  function syncStateFromForm() {
    state.title = titleInput.value.trim();
    state.number = numberInput.value.trim();
    state.date = dateInput.value;
  }

  function syncFormButtons() {
    formButtons.forEach(function (btn) {
      var on = btn.dataset.form === state.form;
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  /** 统计正文结构，给用户一个直观的确认 */
  function renderStats() {
    var count = function (sel) { return docBody.querySelectorAll(sel).length; };

    var items = [
      ["标题", count("h1,h2,h3,h4,h5,h6")],
      ["段落", count("p")],
      ["列表", count("ul,ol")],
      ["图片", count("img")],
      ["字符", (docBody.textContent || "").replace(/\s+/g, "").length]
    ];

    statsEl.replaceChildren.apply(statsEl, items.map(function (pair) {
      var li = document.createElement("li");
      li.textContent = pair[0] + " " + pair[1];
      return li;
    }));
  }

  /* ============================ 草稿存储 ============================ */

  /** IndexedDB 不可用时，在抽屉里说明原因 */
  function reportStorageProblem(err) {
    var msg = "本地草稿存储不可用。\n";

    if (err && /security|not allowed|denied/i.test(String(err.name) + " " + String(err.message))) {
      msg += "如果你是用「双击打开 HTML 文件」的方式访问，浏览器通常会禁止网页数据库。\n" +
             "请改用本地服务器（例如在项目目录运行 python3 -m http.server）或部署后的网址。";
    } else {
      msg += (err && err.message) ? err.message : "未知错误。";
    }

    drawerNotice.className = "drawer-notice";
    drawerNotice.textContent = msg;
    drawerNotice.hidden = false;
    drawerEmpty.hidden = true;
    exportAllBtn.disabled = true;
    saveBtn.disabled = true;
    saveBtn.title = "本地草稿存储不可用";
  }

  /** 保存（新建或更新）当前草稿 */
  async function saveDraft(status) {
    var draftStatus = status || "draft";
    if (!state.bodyHtml) return null;
    if (!window.DraftStore.supported()) {
      showNotice("error", "本地草稿存储不可用，无法保存。");
      return;
    }

    saveBtn.disabled = true;
    setSaveState("正在保存…");

    var now = Date.now();
    var draft = {
      id: state.draftId || window.DraftStore.uniqueId(),
      title: titleInput.value.trim(),
      number: numberInput.value.trim(),
      date: dateInput.value,
      form: state.form,
      fileName: state.fileName || "",
      fileType: state.fileType || "",
      fileSize: state.fileSize || 0,
      fileBlob: state.file || null,
      bodyHtml: state.bodyHtml,
      createdAt: state.createdAt || now,
      updatedAt: now,
      status: draftStatus
    };

    try {
      await window.DraftStore.put(draft);
      state.draftId = draft.id;
      state.createdAt = draft.createdAt;
      state.dirty = false;
      saveBtn.textContent = "更新草稿";
      setSaveState("已保存 · " + formatWhen(now), "ok");
      await refreshDraftList();
      return draft;
    } catch (err) {
      console.error("[draft] 保存失败：", err);
      if (err && /quota/i.test(String(err.name))) {
        showNotice("error", "浏览器存储空间不足，草稿没能保存。\n可以删掉一些旧草稿，或换用不含大图的文档。");
      } else {
        showNotice("error", "草稿保存失败：" + ((err && err.message) || "未知错误"));
      }
      setSaveState("保存失败", "dirty");
    } finally {
      saveBtn.disabled = false;
    }
  }

  /** 打开某份草稿，恢复档案信息并重新预览 */
  async function openDraft(id) {
    if (state.dirty) {
      var ok = window.confirm("当前修改还没保存，仍要打开另一份草稿吗？");
      if (!ok) return;
    }

    var d;
    try {
      d = await window.DraftStore.get(id);
    } catch (err) {
      reportStorageProblem(err);
      return;
    }

    if (!d) {
      showNotice("error", "这份草稿已经不在了，抽屉已刷新。");
      refreshDraftList();
      return;
    }

    hideNotice();

    state.draftId = d.id;
    state.createdAt = d.createdAt || Date.now();
    state.bodyHtml = d.bodyHtml || "";
    state.title = d.title || "";
    state.number = d.number || "";
    state.date = d.date || "";
    state.form = d.form === "book" ? "book" : "letter";
    state.file = d.fileBlob || null;
    state.fileName = d.fileName || "";
    state.fileType = d.fileType || "";
    state.fileSize = d.fileSize || 0;
    state.dirty = false;

    titleInput.value = state.title;
    numberInput.value = state.number;
    dateInput.value = state.date;
    syncFormButtons();

    showFileCard(state.fileName, state.fileSize, state.fileType);
    setStatus("done", "草稿");

    var tpl = document.createElement("template");
    tpl.innerHTML = state.bodyHtml;
    docBody.replaceChildren(tpl.content);

    metaPanel.hidden = false;
    previewEl.hidden = false;

    renderStats();
    renderPreview();

    saveBtn.textContent = "更新草稿";
    setSaveState("已保存 · " + formatWhen(d.updatedAt), "ok");

    await refreshDraftList();
    previewEl.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /** 删除草稿 */
  async function deleteDraft(id) {
    if (!window.confirm("确定删除这份草稿吗？删除后无法恢复。")) return;

    try {
      await window.DraftStore.remove(id);
    } catch (err) {
      showNotice("error", "删除失败：" + ((err && err.message) || "未知错误"));
      return;
    }

    if (state.draftId === id) {
      state.draftId = null;
      state.createdAt = 0;
      saveBtn.textContent = "保存草稿";
      markDirty();
    }
    await refreshDraftList();
  }

  /* ---- 导出备份 ---- */

  function downloadJson(filename, text) {
    var blob = new Blob([text], { type: "application/json;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  /** 把草稿整理成可写进 JSON 的形式（原始 DOCX 转成 base64） */
  async function serializeDraft(d) {
    var item = {
      id: d.id,
      title: d.title || "",
      number: d.number || "",
      date: d.date || "",
      form: d.form || "letter",
      fileName: d.fileName || "",
      fileType: d.fileType || "",
      fileSize: d.fileSize || 0,
      bodyHtml: d.bodyHtml || "",
      createdAt: d.createdAt || null,
      updatedAt: d.updatedAt || null,
      status: d.status || "draft"
    };

    if (d.fileBlob) {
      try {
        item.fileBase64 = await window.DraftStore.blobToBase64(d.fileBlob);
      } catch (e) {
        item.fileBase64 = null;
      }
    }
    return item;
  }

  async function exportDrafts(drafts, filename) {
    setSaveState("正在导出…");
    try {
      var items = [];
      for (var i = 0; i < drafts.length; i++) {
        items.push(await serializeDraft(drafts[i]));
      }

      var payload = {
        app: "Tangerine_Seas's Writing Archive",
        kind: "draft-backup",
        version: 1,
        exportedAt: new Date().toISOString(),
        drafts: items
      };

      downloadJson(filename, JSON.stringify(payload, null, 2));
      setSaveState("已导出 " + drafts.length + " 份", "ok");
    } catch (err) {
      console.error("[draft] 导出失败：", err);
      showNotice("error", "导出失败：" + ((err && err.message) || "未知错误"));
      setSaveState("");
    }
  }

  async function exportOne(id) {
    try {
      var d = await window.DraftStore.get(id);
      if (!d) return;
      var safeNumber = (d.number || "draft").replace(/[^\w\u4e00-\u9fa5-]+/g, "_");
      await exportDrafts([d], "draft-" + safeNumber + ".json");
    } catch (err) {
      showNotice("error", "导出失败：" + ((err && err.message) || "未知错误"));
    }
  }

  async function exportAll() {
    try {
      var rows = await window.DraftStore.list();
      if (!rows.length) return;
      await exportDrafts(rows, "archive-drafts-" + ymd(new Date()) + ".json");
    } catch (err) {
      showNotice("error", "导出失败：" + ((err && err.message) || "未知错误"));
    }
  }

  /* ---- 抽屉列表 ---- */

  function buildDraftItem(d) {
    var li = document.createElement("li");
    li.className = "draft-item";
    if (d.id === state.draftId) li.classList.add("is-current");

    var open = document.createElement("button");
    open.type = "button";
    open.className = "draft-open";
    open.addEventListener("click", function () { openDraft(d.id); });

    var title = document.createElement("span");
    title.className = "draft-title";
    title.textContent = d.title || "（未命名）";

    var meta = document.createElement("span");
    meta.className = "draft-meta";
    meta.textContent = [d.number || "无编号", d.form === "book" ? "book" : "letter"].join(" · ");

    var sub = document.createElement("span");
    sub.className = "draft-sub";
    sub.textContent = formatWhen(d.updatedAt) + " · " + (d.date || "无日期");

    if (d.status === "published") {
      var badge = document.createElement("span");
      badge.className = "draft-badge";
      badge.textContent = "已发布";
      meta.appendChild(badge);
    }

    open.appendChild(title);
    open.appendChild(meta);
    open.appendChild(sub);
    li.appendChild(open);

    var tools = document.createElement("div");
    tools.className = "draft-tools";

    var ex = document.createElement("button");
    ex.type = "button";
    ex.className = "icon-btn";
    ex.textContent = "导出";
    ex.title = "导出这份草稿的 JSON 备份";
    ex.addEventListener("click", function () { exportOne(d.id); });

    var del = document.createElement("button");
    del.type = "button";
    del.className = "icon-btn icon-btn--danger";
    del.textContent = "删除";
    del.title = "删除这份草稿";
    del.addEventListener("click", function () { deleteDraft(d.id); });

    tools.appendChild(ex);
    tools.appendChild(del);
    li.appendChild(tools);

    return li;
  }

  async function refreshDraftList() {
    if (!window.DraftStore.supported()) return;

    var rows;
    try {
      rows = await window.DraftStore.list();
    } catch (err) {
      reportStorageProblem(err);
      return;
    }

    drawerNotice.hidden = true;

    var frag = document.createDocumentFragment();
    rows.forEach(function (d) { frag.appendChild(buildDraftItem(d)); });
    draftList.replaceChildren(frag);

    drawerEmpty.hidden = rows.length > 0;
    drawerCount.textContent = rows.length ? rows.length + " 份" : "";
    exportAllBtn.disabled = rows.length === 0;
  }

  /* ============================ 正式发布 ============================ */

  /** 发布前的必填检查 */
  function validateForPublish() {
    var problems = [];
    if (!titleInput.value.trim()) problems.push("作品标题不能为空。");
    if (!numberInput.value.trim()) problems.push("档案编号不能为空。");
    if (!state.bodyHtml) problems.push("没有正文内容。");
    return problems;
  }

  /**
   * 生成发布包。
   * 注意：这里只产出一个 zip 供下载，不会、也无法直接写入 GitHub 仓库。
   */
  async function publishWork() {
    if (!state.bodyHtml) {
      showNotice("error", "还没有可发布的正文，请先读取一份文档。");
      return;
    }
    if (!window.ArchivePublish || !window.JSZip) {
      showNotice("error", "打包组件没有加载成功，无法生成发布包。刷新页面后重试。");
      return;
    }

    syncStateFromForm();

    var problems = validateForPublish();
    if (problems.length) {
      showNotice("error", "发布前需要先处理：\n" +
        problems.map(function (p) { return "· " + p; }).join("\n"));
      return;
    }

    // 编号重复时先确认，避免无意覆盖别人的目录项
    var dup = [];
    try {
      var rows = await window.DraftStore.listWorks();
      dup = rows.filter(function (w) {
        return w.number === state.number && w.id !== state.draftId;
      });
    } catch (e) { /* 读不到就不拦 */ }

    if (dup.length) {
      var ok = window.confirm(
        "档案编号「" + state.number + "」已经被另一篇作品使用（" +
        (dup[0].title || "无标题") + "）。\n继续发布会覆盖那一篇的目录项，确定继续吗？"
      );
      if (!ok) return;
    }

    // 连上 GitHub 就直接提交，否则退回下载 zip
    if (ghConfig) {
      return publishViaGitHub();
    }

    publishBtn.disabled = true;
    setSaveState("正在打包…");

    try {
      // 先把草稿标记为已发布并保存
      var saved = await saveDraft("published");
      if (!saved) throw new Error("草稿保存失败，已中止发布。");

      var now = Date.now();
      var work = {
        id: saved.id,
        number: state.number,
        title: state.title,
        date: state.date,
        form: state.form,
        chars: (docBody.textContent || "").replace(/\s+/g, "").length,
        bodyHtml: state.bodyHtml,
        fileBlob: state.file || null,
        fileName: state.fileName || "",
        fileSize: state.fileSize || 0,
        publishedAt: now,
        updatedAt: now,
        source: "local"
      };

      // 编号是唯一的：先移除同编号但不同草稿的旧记录，避免目录里出现两条同号作品
      var previous = await window.DraftStore.listWorks();
      for (var i = 0; i < previous.length; i++) {
        if (previous[i].number === work.number && previous[i].id !== work.id) {
          await window.DraftStore.removeWork(previous[i].id);
        }
      }

      await window.DraftStore.putWork(work);

      var all = await window.DraftStore.listWorks();
      var catalog = window.ArchivePublish.buildCatalog(all);
      var pkg = await window.ArchivePublish.buildZip(work, catalog);
      var name = window.ArchivePublish.packageName(work);

      window.ArchivePublish.downloadBlob(name, pkg.blob);

      // 结果面板
      showZipResult(name, pkg.files);

      setSaveState("已生成发布包", "ok");
      await refreshDraftList();

      var notes = [];
      if (!pkg.hasSource) {
        notes.push("· 原始 DOCX 缺失，包里只有 content.html。重新上传原文再发布可以补上。");
      }
      notes.push("· works.json 是完整目录，本次共 " + catalog.count + " 篇。");
      showNotice("info", notes.join("\n"));

    } catch (err) {
      console.error("[publish] 生成发布包失败：", err);
      showNotice("error", "生成发布包失败：" + ((err && err.message) || "未知错误"));
      setSaveState("打包失败", "dirty");
    } finally {
      publishBtn.disabled = false;
    }
  }

  /* ============================ 导入 works.json ============================ */

  async function importWorksFile(file) {
    var text;
    try {
      text = await file.text();
    } catch (e) {
      showNotice("error", "读不到这个文件。");
      return;
    }

    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      showNotice("error", "这不是有效的 JSON 文件。");
      return;
    }

    var items = Array.isArray(data) ? data : (data && Array.isArray(data.works) ? data.works : null);
    if (!items) {
      showNotice("error", "文件里没有 works 数组，可能不是 works.json。");
      return;
    }

    var existing;
    try {
      existing = await window.DraftStore.listWorks();
    } catch (e) {
      reportStorageProblem(e);
      return;
    }

    var byNumber = {};
    existing.forEach(function (w) { byNumber[w.number] = w; });

    var added = 0, updated = 0;
    for (var i = 0; i < items.length; i++) {
      var w = items[i];
      if (!w || !w.number) continue;
      var prev = byNumber[w.number];

      await window.DraftStore.putWork({
        id: (prev && prev.id) || w.id || ("remote-" + w.number),
        number: w.number,
        title: w.title || "",
        date: w.date || "",
        form: w.form === "book" ? "book" : "letter",
        chars: w.chars || 0,
        publishedAt: w.publishedAt || null,
        updatedAt: w.updatedAt || null,
        source: "remote"
      });

      if (prev) updated++; else added++;
    }

    await refreshDraftList();

    drawerNotice.className = "drawer-notice drawer-notice--info";
    drawerNotice.textContent =
      "已导入 works.json：新增 " + added + " 篇，更新 " + updated + " 篇。\n" +
      "当前目录共 " + (existing.length + added) + " 篇。";
    drawerNotice.hidden = false;
  }

  /**
   * 站点部署在 http(s) 上时，尝试把仓库里已有的 data/works.json 并进本地目录，
   * 避免在不同设备上发布时互相覆盖。本地直接双击打开（file://）则跳过。
   */
  async function tryHydrateCatalog() {
    if (!/^https?:$/.test(window.location.protocol)) return 0;

    try {
      var res = await window.fetch("../data/works.json", { cache: "no-store" });
      if (!res.ok) return 0;

      var data = await res.json();
      var items = data && Array.isArray(data.works) ? data.works : [];
      if (!items.length) return 0;

      var existing = await window.DraftStore.listWorks();
      var seen = {};
      existing.forEach(function (w) { seen[w.number] = true; });

      var added = 0;
      for (var i = 0; i < items.length; i++) {
        var w = items[i];
        if (!w || !w.number || seen[w.number]) continue;

        await window.DraftStore.putWork({
          id: w.id || ("remote-" + w.number),
          number: w.number,
          title: w.title || "",
          date: w.date || "",
          form: w.form === "book" ? "book" : "letter",
          chars: w.chars || 0,
          publishedAt: w.publishedAt || null,
          updatedAt: w.updatedAt || null,
          source: "remote"
        });
        added++;
      }
      return added;
    } catch (e) {
      return 0;   // 拿不到就安静跳过
    }
  }

  /* ============================ 发布结果面板 ============================ */

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function codeEl(text) {
    var c = document.createElement("code");
    c.textContent = text;
    return c;
  }

  function showPublishResult(title, blocks) {
    publishTitle.textContent = title;
    publishBody.replaceChildren.apply(publishBody, blocks);
    publishResult.hidden = false;
    publishResult.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  /** 下载 zip 方式的结果面板 */
  function showZipResult(name, files) {
    var line = el("p", "pkg-line");
    line.appendChild(document.createTextNode("已开始下载："));
    line.appendChild(codeEl(name));

    var list = el("ul", "pkg-files");
    files.forEach(function (f) { list.appendChild(el("li", null, f)); });

    var steps = el("ol", "pkg-steps");
    [
      "解压后，把 data/ 和 works/ 复制到仓库根目录（与 index.html 同级）。",
      "git add data works → git commit → git push",
      "等 GitHub Pages 部署完成（通常一两分钟）。"
    ].forEach(function (t) { steps.appendChild(el("li", null, t)); });

    var warn = el("p", "pkg-warn",
      "在你提交并部署之前，作品不会出现在公开网站上。");

    showPublishResult("发布包已生成", [line, list, steps, warn]);
  }

  /** 直连 GitHub 的结果面板 */
  function showGitHubResult(cfg, files, repoUrl) {
    var line = el("p", "pkg-line");
    line.appendChild(document.createTextNode("已提交到仓库 "));
    line.appendChild(codeEl(cfg.owner + "/" + cfg.repo));
    line.appendChild(document.createTextNode("（分支 " + (cfg.branch || "main") + "）。"));

    var list = el("ul", "pkg-files");
    files.forEach(function (f) { list.appendChild(el("li", null, f)); });

    var link = el("p", "pkg-line");
    var a = document.createElement("a");
    a.href = repoUrl;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "在 GitHub 上查看这次提交";
    link.appendChild(a);

    var warn = el("p", "pkg-warn",
      "GitHub Pages 会自动重新部署，通常 1–2 分钟后公开网站就能看到。");

    showPublishResult("已发布到 GitHub", [line, list, link, warn]);
  }

  /* ============================ GitHub 直连 ============================ */

  function updateGhUI() {
    var connected = !!ghConfig;
    ghState.textContent = connected ? "已连接" : "未连接";
    ghState.className = "gh-state" + (connected ? " gh-state--on" : "");
    ghDisconnectBtn.hidden = !connected;
    ghConnectBtn.textContent = connected ? "重新连接" : "连接";
  }

  /** 把仓库里已有的作品目录合并进来，避免覆盖丢失 */
  async function mergeRemoteWorks(cfg) {
    var file = await window.GitHubPublish.readJson(cfg, "data/works.json");
    if (!file || !file.json || !Array.isArray(file.json.works)) return 0;

    var existing = await window.DraftStore.listWorks();
    var seen = {};
    existing.forEach(function (w) { seen[w.number] = true; });

    var added = 0;
    for (var i = 0; i < file.json.works.length; i++) {
      var w = file.json.works[i];
      if (!w || !w.number || seen[w.number]) continue;

      await window.DraftStore.putWork({
        id: w.id || ("remote-" + w.number),
        number: w.number,
        title: w.title || "",
        date: w.date || "",
        form: w.form === "book" ? "book" : "letter",
        chars: w.chars || 0,
        publishedAt: w.publishedAt || null,
        updatedAt: w.updatedAt || null,
        source: "remote"
      });
      added++;
    }
    return added;
  }

  async function connectGitHub() {
    if (!window.GitHubPublish) {
      ghHint.className = "gh-hint gh-hint--error";
      ghHint.textContent = "GitHub 模块没有加载成功，请刷新页面。";
      return;
    }

    var owner = ghOwner.value.trim();
    var repo = ghRepo.value.trim();
    var branch = ghBranch.value.trim() || "main";
    var token = ghToken.value.trim();

    if (!owner || !repo || !token) {
      ghHint.className = "gh-hint gh-hint--error";
      ghHint.textContent = "用户名、仓库名、令牌都要填。";
      return;
    }

    ghConnectBtn.disabled = true;
    ghHint.className = "gh-hint";
    ghHint.textContent = "正在验证…";

    var cfg = { owner: owner, repo: repo, branch: branch, token: token };

    try {
      var info = await window.GitHubPublish.testConnection(cfg);
      cfg.branch = info.branch || branch;

      window.GitHubPublish.saveConfig(cfg);
      ghConfig = cfg;
      ghBranch.value = cfg.branch;
      updateGhUI();

      ghHint.className = "gh-hint gh-hint--ok";
      ghHint.textContent = "已连接 " + info.repo +
        (info.login ? "（" + info.login + "）" : "") +
        " · 分支 " + cfg.branch;

      try {
        var added = await mergeRemoteWorks(cfg);
        if (added) {
          await refreshDraftList();
          ghHint.textContent += " · 已从仓库合并 " + added + " 篇";
        }
      } catch (e) { /* 合并失败不影响连接 */ }

    } catch (err) {
      ghConfig = null;
      updateGhUI();
      ghHint.className = "gh-hint gh-hint--error";
      ghHint.textContent = (err && err.message) || "连接失败";
    } finally {
      ghConnectBtn.disabled = false;
    }
  }

  function disconnectGitHub() {
    if (!window.confirm("断开后，「正式发布」会退回下载 zip 的方式。确定断开吗？")) return;
    window.GitHubPublish.clearConfig();
    ghConfig = null;
    ghToken.value = "";
    updateGhUI();
    ghHint.className = "gh-hint";
    ghHint.textContent = "已断开，令牌已从这台设备删除。";
  }

  function initGitHub() {
    if (!window.GitHubPublish) return;
    var cfg = window.GitHubPublish.loadConfig();
    if (cfg) {
      ghOwner.value = cfg.owner;
      ghRepo.value = cfg.repo;
      ghBranch.value = cfg.branch || "main";
      ghToken.value = cfg.token;
      ghConfig = cfg;
    }
    updateGhUI();
  }

  /**
   * 直连发布：把正文、原始文档、目录依次提交进仓库。
   * works.json 最后写，这样目录永远不会指向还不存在的文件。
   */
  async function publishViaGitHub() {
    publishBtn.disabled = true;
    setSaveState("提交到 GitHub…");

    try {
      // 1. 先合并远程目录，防止把已发布的作品覆盖掉
      try {
        var merged = await mergeRemoteWorks(ghConfig);
        if (merged) await refreshDraftList();
      } catch (e) {
        console.warn("[publish] 合并远程目录失败，继续", e);
      }

      // 2. 存草稿（状态标记为已发布）
      var saved = await saveDraft("published");
      if (!saved) throw new Error("草稿保存失败，已中止发布。");

      // 3. 组装作品记录
      var now = Date.now();
      var work = {
        id: saved.id,
        number: state.number,
        title: state.title,
        date: state.date,
        form: state.form,
        chars: (docBody.textContent || "").replace(/\s+/g, "").length,
        bodyHtml: state.bodyHtml,
        fileBlob: state.file || null,
        fileName: state.fileName || "",
        fileSize: state.fileSize || 0,
        publishedAt: now,
        updatedAt: now,
        source: "local"
      };

      // 同编号的旧记录要先清掉
      var previous = await window.DraftStore.listWorks();
      for (var i = 0; i < previous.length; i++) {
        if (previous[i].number === work.number && previous[i].id !== work.id) {
          await window.DraftStore.removeWork(previous[i].id);
        }
      }
      await window.DraftStore.putWork(work);

      var all = await window.DraftStore.listWorks();
      var catalog = window.ArchivePublish.buildCatalog(all);
      var seg = window.ArchivePublish.safeSegment(work.number);
      var msg = "发布：" + (work.title || work.number);
      var files = [];

      // 4. 正文
      setSaveState("提交正文…");
      await window.GitHubPublish.writeFile(
        ghConfig,
        "works/" + seg + "/content.html",
        window.GitHubPublish.toBase64(window.ArchivePublish.renderContentHtml(work)),
        msg
      );
      files.push("works/" + seg + "/content.html");

      // 5. 原始文档
      if (work.fileBlob) {
        setSaveState("提交原始文档…");
        var docx64 = await window.DraftStore.blobToBase64(work.fileBlob);
        await window.GitHubPublish.writeFile(
          ghConfig,
          "works/" + seg + "/original.docx",
          docx64,
          msg
        );
        files.push("works/" + seg + "/original.docx");
      }

      // 6. 目录最后写
      setSaveState("更新目录…");
      await window.GitHubPublish.writeFile(
        ghConfig,
        "data/works.json",
        window.GitHubPublish.toBase64(JSON.stringify(catalog, null, 2) + "\n"),
        msg + "：更新目录"
      );
      files.push("data/works.json");

      // 7. 完成
      setSaveState("已推送到 GitHub", "ok");
      await refreshDraftList();

      showGitHubResult(
        ghConfig,
        files,
        "https://github.com/" + ghConfig.owner + "/" + ghConfig.repo
      );

      hideNotice();
      if (!work.fileBlob) {
        showNotice("warn", "原始 DOCX 缺失，本次只提交了正文。重新上传原文再发布可以补上。");
      }

    } catch (err) {
      console.error("[publish] 提交到 GitHub 失败：", err);
      setSaveState("发布失败", "dirty");
      showNotice("error",
        "提交到 GitHub 失败：\n" + ((err && err.message) || "未知错误") +
        "\n\n作品没有发布成功。可以修好后再点一次「正式发布」。");
    } finally {
      publishBtn.disabled = false;
    }
  }

  /* ============================ 事件绑定 ============================ */

  // 点击上传区 → 打开文件选择框
  dropzone.addEventListener("click", function () {
    if (!busy) fileInput.click();
  });

  // 键盘可访问：Enter / 空格 等同点击
  dropzone.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      if (!busy) fileInput.click();
    }
  });

  // 选择文件
  fileInput.addEventListener("change", function () {
    var file = fileInput.files && fileInput.files[0];
    if (file) handleFile(file);
    fileInput.value = ""; // 允许连续两次选择同一个文件
  });

  /* ---- 档案信息：标题 / 编号 / 日期实时反映到预览 ---- */

  function onMetaInput() {
    if (metaPanel.hidden) return;
    syncStateFromForm();

    // 信纸预览里直接改信头，避免整块重绘打断阅读位置
    if (state.form === "letter" && window.ArchivePreview) {
      window.ArchivePreview.updateMeta({
        title: state.title,
        number: state.number,
        date: state.date
      });
    }
    markDirty();
  }

  titleInput.addEventListener("input", onMetaInput);
  numberInput.addEventListener("input", onMetaInput);
  dateInput.addEventListener("input", onMetaInput);

  /* ---- 阅读形式切换 ---- */

  formButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (metaPanel.hidden) return;
      var form = btn.dataset.form;
      if (form === state.form) return;

      syncStateFromForm();
      state.form = form;
      syncFormButtons();
      renderPreview();
      markDirty();
    });
  });

  /* ---- 保存草稿 ---- */

  saveBtn.addEventListener("click", function () { saveDraft("draft"); });
  exportAllBtn.addEventListener("click", exportAll);
  publishBtn.addEventListener("click", publishWork);
  ghConnectBtn.addEventListener("click", connectGitHub);
  ghDisconnectBtn.addEventListener("click", disconnectGitHub);

  importBtn.addEventListener("click", function () { importInput.click(); });
  importInput.addEventListener("change", function () {
    var f = importInput.files && importInput.files[0];
    if (f) importWorksFile(f);
    importInput.value = "";
  });

  /* ---- 拖拽 ---- */

  ["dragenter", "dragover"].forEach(function (evt) {
    dropzone.addEventListener(evt, function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (busy) return;
      if (evt === "dragenter") dragDepth++;
      dropzone.classList.add("is-over");
    });
  });

  dropzone.addEventListener("dragleave", function (e) {
    e.preventDefault();
    e.stopPropagation();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropzone.classList.remove("is-over");
  });

  dropzone.addEventListener("drop", function (e) {
    e.preventDefault();
    e.stopPropagation();
    dragDepth = 0;
    dropzone.classList.remove("is-over");

    if (busy) return;

    var files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) {
      showNotice("error", "没有检测到文件。请从系统文件管理器里拖入 .docx 文件。");
      return;
    }

    if (files.length > 1) {
      showNotice("info", "一次只能读取一份文稿，已选用第一个文件「" + files[0].name + "」。");
    }

    handleFile(files[0]);
  });

  // 防止文件被拖到上传区之外时，浏览器直接打开它
  window.addEventListener("dragover", function (e) { e.preventDefault(); });
  window.addEventListener("drop", function (e) { e.preventDefault(); });

  /* ---- 移除 ---- */

  clearBtn.addEventListener("click", function () {
    if (busy) return;
    if (state.dirty && !window.confirm("当前草稿还有未保存的修改，确定要清空工作台吗？")) {
      return;
    }

    fileCard.hidden = true;
    statusEl.className = "status";
    statusEl.textContent = "";
    hideNotice();
    resetView();

    state.bodyHtml = "";
    state.title = "";
    state.number = "";
    state.date = "";
    state.draftId = null;
    state.createdAt = 0;
    state.file = null;
    state.fileName = "";
    state.fileType = "";
    state.fileSize = 0;
    state.dirty = false;
    saveBtn.textContent = "保存草稿";
    setSaveState("");
    refreshDraftList();
  });

  /* ---- 离开页面前提醒未保存 ---- */

  window.addEventListener("beforeunload", function (e) {
    if (!state.dirty || !state.bodyHtml) return;
    e.preventDefault();
    e.returnValue = "";
  });

  /* ============================ 初始化 ============================ */

  (function boot() {
    if (!window.DraftStore.supported()) {
      reportStorageProblem(new Error("这个浏览器不支持 IndexedDB。"));
      return;
    }

    initGitHub();

    refreshDraftList()
      .then(tryHydrateCatalog)
      .then(function (added) {
        if (!added) return null;
        return refreshDraftList().then(function () {
          drawerNotice.className = "drawer-notice drawer-notice--info";
          drawerNotice.textContent = "已从 data/works.json 合并 " + added + " 篇已发布作品。";
          drawerNotice.hidden = false;
        });
      })
      .catch(function (err) {
        reportStorageProblem(err);
      });
  })();
})();
