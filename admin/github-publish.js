/* ==========================================================================
   admin/github-publish.js
   第六阶段补充：浏览器直连 GitHub，把作品直接提交进仓库

   说明：
     · 令牌由使用者自己在页面上粘贴，只保存在「这台设备的浏览器」的
       localStorage 里，不写进任何代码、不随仓库发布。
     · 请求只发往 api.github.com，不经过任何第三方服务器。
     · 这里只管「怎么和 GitHub 说话」，具体发布哪些文件由 upload.js 决定。

   用到的接口：
     GET  /repos/{owner}/{repo}                    验证令牌与仓库
     GET  /repos/{owner}/{repo}/contents/{path}    取文件（拿 sha）
     PUT  /repos/{owner}/{repo}/contents/{path}    新建或更新文件
   ========================================================================== */

(function (global) {
  "use strict";

  var API = "https://api.github.com";
  var STORAGE_KEY = "ts.github";

  /* ============================ 配置存取 ============================ */

  /** 读取本地保存的连接配置，没有或不完整返回 null */
  function loadConfig() {
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var cfg = JSON.parse(raw);
      if (!cfg || !cfg.token || !cfg.owner || !cfg.repo) return null;
      cfg.branch = cfg.branch || "main";
      return cfg;
    } catch (e) {
      return null;
    }
  }

  function saveConfig(cfg) {
    global.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      owner: cfg.owner,
      repo: cfg.repo,
      branch: cfg.branch || "main",
      token: cfg.token
    }));
  }

  function clearConfig() {
    try {
      global.localStorage.removeItem(STORAGE_KEY);
    } catch (e) { /* 忽略 */ }
  }

  /* ============================ 工具 ============================ */

  function enc(s) {
    return encodeURIComponent(String(s));
  }

  /** 路径按段编码，保留斜杠 */
  function encPath(path) {
    return String(path).split("/").map(enc).join("/");
  }

  /** UTF-8 字符串 → base64（分块，避免大文本爆栈） */
  function toBase64(text) {
    var bytes = new TextEncoder().encode(text);
    var chunk = 0x8000;
    var binary = "";
    for (var i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return global.btoa(binary);
  }

  /** 把 GitHub 的错误码翻译成人话 */
  function errorMessage(status, data) {
    var detail = data && data.message ? data.message : "";

    if (status === 401) return "令牌无效或已过期，请重新生成后再连接。";
    if (status === 403) {
      if (/rate limit/i.test(detail)) return "触发了 GitHub 的请求频率限制，稍等几分钟再试。";
      return "令牌权限不足，请确认它对这个仓库有 Contents 读写权限。";
    }
    if (status === 404) return "找不到仓库或文件。请检查用户名/仓库名，以及令牌是否有该仓库的权限。";
    if (status === 409) return "远程文件已经被改动，请重试。";
    if (status === 422) return "提交被拒绝：" + (detail || "参数不合法");
    return "GitHub 返回 " + status + (detail ? "：" + detail : "");
  }

  /** 统一请求封装 */
  function request(cfg, path, options) {
    var opts = options || {};

    var headers = {
      "Authorization": "Bearer " + cfg.token,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (opts.body) headers["Content-Type"] = "application/json";

    var init = {
      method: opts.method || "GET",
      headers: headers,
      cache: "no-store"
    };
    if (opts.body) init.body = JSON.stringify(opts.body);

    return global.fetch(API + path, init).then(function (res) {
      if (res.status === 204) return null;

      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }

        if (!res.ok) {
          var err = new Error(errorMessage(res.status, data));
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    }).catch(function (err) {
      if (err && err.status) throw err;
      throw new Error("连不上 GitHub，请检查网络后重试。");
    });
  }

  function repoPath(cfg, suffix) {
    return "/repos/" + enc(cfg.owner) + "/" + enc(cfg.repo) + suffix;
  }

  /* ============================ 对外接口 ============================ */

  /** 验证令牌 + 仓库，返回 {login, repo, branch, private} */
  function testConnection(cfg) {
    var info = {};

    return request(cfg, repoPath(cfg, ""))
      .then(function (repo) {
        info.repo = repo.full_name;
        info.branch = repo.default_branch || cfg.branch || "main";
        info.private = !!repo.private;

        // 顺带拿一下当前登录账号（失败不影响主流程）
        return request(cfg, "/user").then(function (user) {
          info.login = user.login;
          return info;
        }).catch(function () { return info; });
      });
  }

  /**
   * 读取仓库里的文件。
   * @returns {Promise<{text:string, sha:string}|null>} 文件不存在返回 null
   */
  function readFile(cfg, path) {
    return request(cfg, repoPath(cfg, "/contents/" + encPath(path) + "?ref=" + enc(cfg.branch || "main")))
      .then(function (data) {
        if (!data) return null;
        if (Array.isArray(data)) return null;           // 是个目录
        if (data.encoding !== "base64") return null;

        var binary = global.atob(String(data.content).replace(/\s/g, ""));
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        return {
          text: new TextDecoder("utf-8").decode(bytes),
          sha: data.sha
        };
      })
      .catch(function (err) {
        if (err.status === 404) return null;
        throw err;
      });
  }

  /** 读取 JSON 文件，解析失败返回 null */
  function readJson(cfg, path) {
    return readFile(cfg, path).then(function (file) {
      if (!file) return null;
      var json = null;
      try { json = JSON.parse(file.text); } catch (e) { json = null; }
      return { json: json, sha: file.sha };
    });
  }

  /**
   * 新建或覆盖一个文件（内容已是 base64）。
   * 遇到 409（远程刚被改过）会重新取一次 sha 再试。
   */
  function writeFile(cfg, path, contentBase64, message, retried) {
    var branch = cfg.branch || "main";

    return request(cfg, repoPath(cfg, "/contents/" + encPath(path) + "?ref=" + enc(branch)))
      .then(function (existing) { return existing && existing.sha ? existing.sha : null; })
      .catch(function (err) {
        if (err.status === 404) return null;   // 文件还不存在
        throw err;
      })
      .then(function (sha) {
        var body = {
          message: message,
          content: contentBase64,
          branch: branch
        };
        if (sha) body.sha = sha;

        return request(cfg, repoPath(cfg, "/contents/" + encPath(path)), {
          method: "PUT",
          body: body
        });
      })
      .catch(function (err) {
        if (err.status === 409 && !retried) {
          return writeFile(cfg, path, contentBase64, message, true);
        }
        throw err;
      });
  }

  global.GitHubPublish = {
    loadConfig: loadConfig,
    saveConfig: saveConfig,
    clearConfig: clearConfig,
    testConnection: testConnection,
    readJson: readJson,
    readFile: readFile,
    writeFile: writeFile,
    toBase64: toBase64
  };

})(window);
