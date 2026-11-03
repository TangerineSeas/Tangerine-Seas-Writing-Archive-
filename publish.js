/* ==========================================================================
   admin/publish.js
   第五阶段：生成正式发布文件包

   重要：这个模块只在本地产出一个 zip，**不会**、也不可能直接写入 GitHub 仓库。
   作品要真正上线，必须由你手动把生成的文件提交进仓库并部署。

   生成的包结构：
     README.txt                        发布说明
     data/works.json                   作品目录（完整，含全部已发布作品）
     works/<档案编号>/content.html     正文
     works/<档案编号>/original.docx    原始文档

   同时兼容第六阶段的档案柜约定：
     works.json 里 works 按编号升序排列，drawerSize 表示每个抽屉容纳的篇数。
   ========================================================================== */

(function (global) {
  "use strict";

  var DRAWER_SIZE = 10;   // 每个抽屉 10 篇（约定为 8–10）

  /* ============================ 工具 ============================ */

  /** 把档案编号变成安全的目录名 */
  function safeSegment(text) {
    var s = String(text == null ? "" : text)
      .trim()
      .replace(/[\\/:*?"<>|]/g, "_")   // 路径非法字符
      .replace(/\s+/g, "_")
      .replace(/^\.+/, "")             // 避免以点开头
      .slice(0, 60);
    return s || "work";
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function stamp(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
           " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  /* ============================ content.html ============================ */

  /**
   * 生成独立可打开的正文页面。
   * 正文放在 <main id="work-body"> 里，第六阶段可以直接取这一块注入阅读器。
   */
  function renderContentHtml(work) {
    var title = escapeHtml(work.title || "无标题");
    var number = escapeHtml(work.number || "");
    var date = escapeHtml(work.date || "");
    var body = work.bodyHtml || "";

    return [
      "<!DOCTYPE html>",
      '<html lang="zh-CN">',
      "<head>",
      '<meta charset="UTF-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      "<title>" + title + " · Tangerine_Seas's Writing Archive</title>",
      "<style>",
      "  body{margin:0;padding:48px 20px;background:#e9dcc4;color:#4a3728;",
      '       font-family:Georgia,"Times New Roman","Songti SC","STSong",serif;}',
      "  .work{max-width:720px;margin:0 auto;padding:48px 52px;background:#fffaf0;",
      "        border:1px solid #e0d0b2;box-shadow:0 18px 40px -28px #4c392b80;}",
      "  .work-head{border-bottom:1px solid #eadcc2;padding-bottom:18px;margin-bottom:28px;}",
      "  .work-meta{margin:0;font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#a38a6b;}",
      "  .work-head h1{margin:10px 0 0;font-size:28px;font-weight:400;font-style:italic;line-height:1.35;}",
      "  #work-body{font-size:15px;line-height:1.95;}",
      "  #work-body p{margin:0 0 1em;}",
      "  #work-body h1,#work-body h2,#work-body h3,#work-body h4,#work-body h5,#work-body h6",
      "    {font-weight:400;font-style:italic;margin:1.6em 0 .6em;line-height:1.4;}",
      "  #work-body h1{font-size:24px}#work-body h2{font-size:20px}#work-body h3{font-size:17px}",
      "  #work-body blockquote{margin:1.2em 0;padding-left:1.2em;border-left:2px solid #d9c6a4;",
      "                        font-style:italic;color:#6d5741;}",
      "  #work-body ul,#work-body ol{margin:0 0 1em;padding-left:1.6em;}",
      "  #work-body img{max-width:100%;height:auto;display:block;margin:1.2em auto;",
      "                 padding:6px;background:#fffdf7;border:1px solid #e2d3b6;}",
      "  #work-body table{width:100%;border-collapse:collapse;font-size:13px;}",
      "  #work-body th,#work-body td{border:1px solid #ddccae;padding:8px 10px;text-align:left;}",
      "  @media (max-width:640px){.work{padding:28px 22px}#work-body{font-size:14px}}",
      "</style>",
      "</head>",
      "<body>",
      '<article class="work" id="work"',
      '  data-number="' + escapeAttr(work.number) + '"',
      '  data-title="' + escapeAttr(work.title) + '"',
      '  data-form="' + escapeAttr(work.form || "letter") + '">',
      '  <header class="work-head">',
      '    <p class="work-meta">No. ' + number + (date ? " · " + date : "") + "</p>",
      "    <h1>" + title + "</h1>",
      "  </header>",
      '  <main id="work-body">',
      body,
      "  </main>",
      "</article>",
      "</body>",
      "</html>",
      ""
    ].join("\n");
  }

  /* ============================ works.json ============================ */

  /**
   * 把本地记录的已发布作品整理成目录。
   * 按编号升序 —— 定长编号的字符串序即时间序。
   */
  function buildCatalog(works) {
    // 按编号去重：万一历史数据里同号有多条，只保留最近发布的那条，
    // 否则 works.json 会出现两条指向同一路径的记录。
    var byNumber = {};
    works.forEach(function (w) {
      var key = String(w.number || "").trim();
      if (!key) return;
      var prev = byNumber[key];
      if (!prev || (w.publishedAt || 0) >= (prev.publishedAt || 0)) byNumber[key] = w;
    });

    var rows = Object.keys(byNumber).map(function (k) { return byNumber[k]; });
    rows.sort(function (a, b) {
      return String(a.number || "").localeCompare(String(b.number || ""));
    });

    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      drawerSize: DRAWER_SIZE,
      count: rows.length,
      works: rows.map(function (w) {
        var seg = safeSegment(w.number);
        return {
          id: w.id || seg,
          number: w.number || "",
          title: w.title || "",
          date: w.date || "",
          form: w.form === "book" ? "book" : "letter",
          chars: w.chars || 0,
          contentFile: "works/" + seg + "/content.html",
          sourceFile: "works/" + seg + "/original.docx",
          publishedAt: w.publishedAt || null,
          updatedAt: w.updatedAt || null
        };
      })
    };
  }

  /* ============================ README ============================ */

  function buildReadme(work, catalog, hasSource) {
    var lines = [
      "Tangerine_Seas's Writing Archive — 发布包",
      "==========================================",
      "",
      "这个压缩包由本地工具生成，还没有发布到任何服务器。",
      "在你把文件提交到 GitHub 并完成部署之前，作品不会出现在公开网站上。",
      "",
      "本次作品",
      "--------",
      "标题：" + (work.title || "（无标题）"),
      "编号：" + (work.number || "（无编号）"),
      "形式：" + (work.form === "book" ? "book（小册子）" : "letter（信纸）"),
      "生成时间：" + stamp(new Date()),
      "",
      "包内文件",
      "--------",
      "README.txt                          本说明",
      "data/works.json                     作品目录（完整，共 " + catalog.count + " 篇）",
      "works/" + safeSegment(work.number) + "/content.html            正文",
      hasSource
        ? "works/" + safeSegment(work.number) + "/original.docx           原始文档"
        : "（原始文档缺失：这份草稿没有保存原始 DOCX，请重新上传后再发布）",
      "",
      "如何发布",
      "--------",
      "1. 解压后，把 data/ 和 works/ 两个文件夹复制到仓库根目录（与 index.html 同级）。",
      "",
      "2. 提交并推送：",
      "",
      "     git add data works",
      '     git commit -m "发布：' + (work.title || work.number) + '"',
      "     git push",
      "",
      "3. 等 GitHub Pages 部署完成（通常一两分钟），作品才会出现在公开网站。",
      "",
      "注意",
      "----",
      "· works.json 是完整目录，不是增量。如果你在另一台设备上也发布过作品，",
      "  那份数据不在这个包里，直接覆盖会丢失。发布前请在抽屉里「导入 works.json」",
      "  合并，或确认这份目录已经包含全部作品。",
      "· 首页档案柜读取 data/works.json，每 " + catalog.drawerSize + " 篇作品一个抽屉。",
      "· 本工具不会也不能直接写入你的 GitHub 仓库，全程没有任何令牌或自动上传。",
      ""
    ];
    return lines.join("\n");
  }

  /* ============================ 打包 ============================ */

  /**
   * 生成 zip。
   * @param {object} work    当前作品（含 bodyHtml / fileBlob）
   * @param {object} catalog buildCatalog() 的结果
   * @returns {Promise<{blob: Blob, segment: string, files: string[]}>}
   */
  function buildZip(work, catalog) {
    if (!global.JSZip) {
      return Promise.reject(new Error("打包库 JSZip 未加载，无法生成发布包。"));
    }

    var zip = new global.JSZip();
    var seg = safeSegment(work.number);
    var hasSource = !!work.fileBlob;
    var files = [];

    zip.file("README.txt", buildReadme(work, catalog, hasSource));
    files.push("README.txt");

    zip.file("data/works.json", JSON.stringify(catalog, null, 2) + "\n");
    files.push("data/works.json");

    zip.file("works/" + seg + "/content.html", renderContentHtml(work));
    files.push("works/" + seg + "/content.html");

    if (hasSource) {
      zip.file("works/" + seg + "/original.docx", work.fileBlob);
      files.push("works/" + seg + "/original.docx");
    }

    return zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 }
    }).then(function (blob) {
      return { blob: blob, segment: seg, files: files, hasSource: hasSource };
    });
  }

  /** 发布包文件名 */
  function packageName(work) {
    return "publish-" + safeSegment(work.number) + ".zip";
  }

  /** 触发浏览器下载 */
  function downloadBlob(filename, blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    global.setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  global.ArchivePublish = {
    DRAWER_SIZE: DRAWER_SIZE,
    safeSegment: safeSegment,
    renderContentHtml: renderContentHtml,
    buildCatalog: buildCatalog,
    buildZip: buildZip,
    packageName: packageName,
    downloadBlob: downloadBlob
  };

})(window);
