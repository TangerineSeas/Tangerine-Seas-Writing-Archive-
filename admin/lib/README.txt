lib/mammoth.browser.min.js
==========================

Mammoth.js 1.13.0 — 浏览器版本（UMD 构建）
用途：在浏览器端把 .docx 转换成 HTML，供 admin/upload.html 使用。

来源：https://github.com/mwilliamson/mammoth.js
发布包：https://unpkg.com/mammoth@1.13.0/mammoth.browser.min.js
许可证：BSD 2-Clause

为什么放在本地而不是用 CDN：
网站部署在 GitHub Pages，本地引用可以离线使用，
也不会因为第三方 CDN 不可达而让上传功能失效。

升级方式：
下载新版本覆盖本文件即可，调用方式是 window.mammoth.convertToHtml()。

--------------------------------------------------------------------------

lib/jszip.min.js
================

JSZip 3.10.1 — 浏览器版本
用途：把发布包（works.json + content.html + original.docx）打成 zip 供下载。

来源：https://github.com/Stuk/jszip
发布包：https://unpkg.com/jszip@3.10.1/dist/jszip.min.js
许可证：MIT / GPLv3 双许可（本处按 MIT 使用）

调用方式是 window.JSZip。
