/* 籽三 · 手机只读端 —— 逻辑（M2：双数据源 + 离线缓存）
   ─────────────────────────────────────────────────────────────────────
   两种数据源（设置里切，存在 localStorage）：
     · pc ：局域网直连电脑上的只读服务（实时；要求电脑开着、同网）
     · gh ：从 GitHub 私有仓库拉「离线包」（`_sync/manifest.json` + `_sync/pack/*.json`）
            —— **不依赖电脑开机**；包是电脑侧用 Python 预先生成的（章级＋节级已合并、
            知识点已解析），手机只负责下载与缓存，因此不必在 JS 里重写那套逻辑。

   离线缓存用 **IndexedDB**（不是 Service Worker）：因为局域网 `http://` 不是安全上下文，
   浏览器会拒绝注册 SW；而 IndexedDB **不受此限制**，所以手机上一样能离线读已下载的课程。
   （应用外壳的离线由浏览器 HTTP 缓存兜底，见 mobile.py 里的缓存头注释。）

   只读：本文件不含任何写操作。 */
(function () {
  'use strict';

  var LS_KEY = 'zs_settings';
  var $ = function (s) { return document.querySelector(s); };
  var state = { course: '', chapter: '', tab: 'note', data: null, tree: null, manifest: null };

  // ── 设置 ─────────────────────────────────────────────────────────
  function settings() {
    var d = { mode: 'pc', owner: '', repo: '', branch: 'master', token: '' };
    try { return Object.assign(d, JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}); } catch (e) { return d; }
  }
  function saveSettings(p) {
    var s = Object.assign(settings(), p || {});
    try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) {}
    return s;
  }

  // ── IndexedDB（离线缓存）─────────────────────────────────────────
  var DB = null;
  function dbOpen() {
    if (DB) return Promise.resolve(DB);
    return new Promise(function (res, rej) {
      var r = indexedDB.open('ziisan', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
      r.onsuccess = function () { DB = r.result; res(DB); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function kvGet(k) {
    return dbOpen().then(function (d) {
      return new Promise(function (res) {
        var t = d.transaction('kv', 'readonly').objectStore('kv').get(k);
        t.onsuccess = function () { res(t.result); };
        t.onerror = function () { res(null); };
      });
    });
  }
  function kvSet(k, v) {
    return dbOpen().then(function (d) {
      return new Promise(function (res) {
        var t = d.transaction('kv', 'readwrite').objectStore('kv').put(v, k);
        t.onsuccess = function () { res(true); };
        t.onerror = function () { res(false); };
      });
    });
  }
  function kvKeys() {
    return dbOpen().then(function (d) {
      return new Promise(function (res) {
        var t = d.transaction('kv', 'readonly').objectStore('kv').getAllKeys();
        t.onsuccess = function () { res(t.result || []); };
        t.onerror = function () { res([]); };
      });
    });
  }

  // ── 令牌（pc 模式的访问令牌）─────────────────────────────────────
  function readToken() {
    var m = location.search.match(/[?&]token=([^&]+)/);
    if (m) {
      try { localStorage.setItem('zs_token', decodeURIComponent(m[1])); } catch (e) {}
      history.replaceState(null, '', location.pathname + location.hash);   // 别把令牌留在地址栏
      return;
    }
  }
  function pcToken() { try { return localStorage.getItem('zs_token') || ''; } catch (e) { return ''; } }

  // ── 数据源：pc ───────────────────────────────────────────────────
  function pcApi(path, params) {
    var q = [];
    for (var k in (params || {})) { if (params[k] != null && params[k] !== '') q.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k])); }
    var tk = pcToken();
    if (tk) q.push('token=' + encodeURIComponent(tk));
    return fetch('/m/api/' + path + (q.length ? '?' + q.join('&') : ''), { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 401) throw new Error('NEED_TOKEN');
        if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || ('HTTP ' + r.status)); });
        return r.json();
      });
  }

  // ── 数据源：GitHub ───────────────────────────────────────────────
  function ghFetch(path) {
    var s = settings();
    if (!s.owner || !s.repo || !s.token) throw new Error('还没填 GitHub 用户名/仓库/令牌（点右上角 ☁ 设置）');
    var url = 'https://api.github.com/repos/' + encodeURIComponent(s.owner) + '/' + encodeURIComponent(s.repo) +
      '/contents/' + path.split('/').map(encodeURIComponent).join('/') +
      '?ref=' + encodeURIComponent(s.branch || 'master');
    return fetch(url, {
      headers: {
        'Authorization': 'Bearer ' + s.token,
        'Accept': 'application/vnd.github.raw+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    }).then(function (r) {
      if (r.status === 401) throw new Error('GitHub 令牌无效（401）');
      if (r.status === 404) throw new Error('找不到 ' + path + '（仓库名/分支/路径不对，或令牌没有这个仓库的 Contents:Read）');
      if (r.status === 403) throw new Error('GitHub 拒绝（403）：可能是令牌权限不足、限流，或文件超过 1MB 接口上限');
      if (!r.ok) throw new Error('GitHub HTTP ' + r.status);
      return r.text();
    });
  }

  function ghManifest(force) {
    if (!force && state.manifest) return Promise.resolve(state.manifest);
    return ghFetch('_sync/manifest.json').then(function (txt) {
      var m = JSON.parse(txt);
      state.manifest = m;
      kvSet('manifest', m);                       // 离线也能列目录（内容仍取缓存里的包）
      return m;
    }).catch(function (e) {
      return kvGet('manifest').then(function (m) {
        if (m) { state.manifest = m; return m; }
        throw e;
      });
    });
  }

  function ghTree(force) {
    return ghManifest(force).then(function (m) {
      var courses = (m.courses || []).map(function (c) {
        var chapters = [];
        (c.packs || []).forEach(function (p) { (p.chapterIndex || []).forEach(function (ci) { chapters.push(ci); }); });
        return {
          name: c.name, total: chapters.length,
          taught: chapters.filter(function (x) { return x.taught; }).length, chapters: chapters
        };
      });
      return { courses: courses, generatedAt: m.generatedAt || '' };
    });
  }

  function packKey(file) { var s = settings(); return 'gh/' + s.owner + '/' + s.repo + '/' + file; }

  /** manifest 里的 file 是**相对 `_sync/` 的路径**（如 `pack/xxx.json`）——
   *  必须补上前缀再请求，否则 GitHub 直接 404（实测踩到，别再省这一步）。 */
  function packPath(file) { return '_sync/' + String(file).replace(/^\/+/, ''); }

  /** 取整门课的包（缺哪个下哪个，sha 变了才重下）。返回该课程所有章。 */
  function ghCourse(courseName, onProgress) {
    return ghManifest().then(function (m) {
      var c = (m.courses || []).filter(function (x) { return x.name === courseName; })[0];
      if (!c) throw new Error('manifest 里没有这门课：' + courseName);
      var packs = c.packs || [];
      var out = [];
      return packs.reduce(function (chain, p, i) {
        return chain.then(function () {
          var key = packKey(p.file);
          return kvGet(key).then(function (hit) {
            if (hit && hit.sha === p.sha256 && hit.json) {
              if (onProgress) onProgress(i + 1, packs.length, true);
              out = out.concat(hit.json.chapters || []);
              return;
            }
            if (onProgress) onProgress(i + 1, packs.length, false);
            return ghFetch(packPath(p.file)).then(function (txt) {
              var j = JSON.parse(txt);
              return kvSet(key, { sha: p.sha256, json: j, at: Date.now() }).then(function () {
                out = out.concat(j.chapters || []);
              });
            });
          });
        });
      }, Promise.resolve()).then(function () { return out; });
    });
  }

  // ── 统一数据层（渲染层只认这三个函数）─────────────────────────────
  function listTree(force) {
    return settings().mode === 'gh' ? ghTree(force) : pcApi('tree');
  }
  function getChapter(course, chapter, onProgress) {
    if (settings().mode !== 'gh') return pcApi('chapter', { course: course, chapter: chapter });
    return ghCourse(course, onProgress).then(function (chs) {
      var hit = chs.filter(function (x) { return x.name === chapter; })[0];
      if (!hit) throw new Error('包里没有这一章：' + chapter);
      return { ok: true, course: course, chapter: chapter, note: hit.note || '', qa: hit.qa || '', kps: hit.kps || [] };
    });
  }
  function doSearchApi(term) {
    if (settings().mode !== 'gh') return pcApi('search', { q: term });
    // GitHub 模式是**本地检索**：只能在已缓存的包里搜 —— 如实标注，不假装能全库搜。
    return kvKeys().then(function (keys) {
      var mine = keys.filter(function (k) { return String(k).indexOf('gh/') === 0; });
      var kps = [];
      var low = term.toLowerCase();
      return mine.reduce(function (chain, k) {
        return chain.then(function () {
          return kvGet(k).then(function (v) {
            var j = v && v.json;
            if (!j || !j.chapters) return;
            j.chapters.forEach(function (ch) {
              (ch.kps || []).forEach(function (kp) {
                if ((kp.name || '').toLowerCase().indexOf(low) >= 0) {
                  kps.push({ name: kp.name, course: j.course, chapter: ch.name, section: kp.section || '', summary: '' });
                }
              });
            });
          });
        });
      }, Promise.resolve()).then(function () { return { kps: kps.slice(0, 60), terms: [] }; });
    });
  }

  // ── 渲染 ─────────────────────────────────────────────────────────
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function md(text) {
    try { return window.marked ? window.marked.parse(text || '', { gfm: true, breaks: false }) : '<pre>' + esc(text) + '</pre>'; }
    catch (e) { return '<pre>' + esc(text) + '</pre>'; }
  }
  function setNet(ok, text) { var el = $('#net'); el.textContent = text; el.style.background = ok ? 'rgba(255,255,255,.18)' : 'rgba(255,120,120,.35)'; }
  function srcLabel() { var s = settings(); return s.mode === 'gh' ? ('GitHub · ' + (s.repo || '未设置')) : '局域网 · 电脑'; }

  function loadHome(force) {
    $('#courses').innerHTML = '<div class="loading">正在读取课程树…</div>';
    $('#sub').textContent = '只读 · ' + srcLabel();
    listTree(force).then(function (d) {
      state.tree = d;
      var courses = d.courses || [];
      var totalCh = 0, taught = 0;
      courses.forEach(function (c) { totalCh += (c.total || 0); taught += (c.taught || 0); });
      $('#stats').textContent = srcLabel() + '｜课程 ' + courses.length + ' · 章节 ' + totalCh + ' · 已讲解 ' + taught +
        (d.generatedAt ? '｜包生成于 ' + d.generatedAt : '');
      $('#courses').innerHTML = courses.map(function (c, i) {
        var rows = (c.chapters || []).map(function (ch) {
          return '<div class="ch' + (ch.taught ? '' : ' dim') + '" data-course="' + esc(c.name) + '" data-chapter="' + esc(ch.name) + '">' +
            '<span class="pill' + (ch.taught ? ' ok' : '') + '">' + (ch.taught ? '已讲解' : '骨架') + '</span>' +
            '<span class="nm">' + esc(ch.name) + '</span>' +
            (ch.kps ? '<span class="pill">' + ch.kps + ' 知识点</span>' + '' : '') + '</div>';
        }).join('');
        return '<details class="course"' + (i === 0 ? ' open' : '') + '><summary><span class="nm">' + esc(c.name) + '</span>' +
          '<span class="pill">' + (c.taught || 0) + '/' + (c.total || 0) + '</span></summary>' +
          '<div class="chs">' + (rows || '<div class="empty">这一门还没有章节</div>') + '</div></details>';
      }).join('') || '<div class="empty">没有课程（GitHub 模式请先点 ☁ 填仓库并同步）</div>';
      setNet(true, settings().mode === 'gh' ? 'GitHub' : '在线');
    }).catch(function (e) {
      setNet(false, '离线');
      $('#courses').innerHTML = '<div class="empty">' + (e.message === 'NEED_TOKEN'
        ? '需要访问令牌：请用带 <code>?token=…</code> 的链接重新打开一次。'
        : esc(e.message)) + '<br><br>点右上角 <b>☁</b> 可切换数据源（GitHub 离线包不需要电脑开机）。</div>';
    });
  }

  function openChapter(course, chapter) {
    state.course = course; state.chapter = chapter; state.tab = 'note';
    $('#home').hidden = true; $('#chapter').hidden = false; $('#back').hidden = false;
    $('#ttl').textContent = chapter;
    $('#sub').textContent = course + ' · ' + srcLabel();
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('on', t.dataset.tab === 'note'); });
    $('#content').innerHTML = '<div class="loading">正在取笔记…</div>';
    getChapter(course, chapter, function (i, n, cached) {
      $('#content').innerHTML = '<div class="loading">正在下载这一门课的包（' + i + '/' + n + '）' +
        (cached ? '　已缓存 ✓' : '') + '…</div>';
    }).then(function (d) {
      state.data = d; renderTab('note');
    }).catch(function (e) {
      $('#content').innerHTML = '<div class="empty">取不到：' + esc(e.message) + '</div>';
    });
  }

  function renderTab(tab) {
    state.tab = tab;
    var d = state.data || {}, el = $('#content');
    if (tab === 'qa') {
      el.innerHTML = d.qa ? md(d.qa) : '<div class="empty">这一章还没有 思考题解析.md</div>';
    } else if (tab === 'kps') {
      var ks = d.kps || [], sec = '';
      el.innerHTML = ks.length ? ks.map(function (k) {
        var head = '';
        if (k.section && k.section !== sec) { sec = k.section; head = '<h3>' + esc(sec) + '</h3>'; }
        return head + '<p><strong>' + esc(k.name) + '</strong>' + (k.en ? '（' + esc(k.en) + '）' : '') + '</p>';
      }).join('') : '<div class="empty">这一章没有按「一、二、」编号的知识点。<br>可能是早期模板写的，或这是一张章级总图 —— 正文在「知识点笔记」页签里仍可读。</div>';
    } else {
      el.innerHTML = d.note ? md(d.note) : '<div class="empty">这一章还没有 知识点笔记.md</div>';
    }
  }

  function goHome() {
    $('#chapter').hidden = true; $('#home').hidden = false; $('#back').hidden = true;
    $('#ttl').textContent = '籽三 · 学习库';
    $('#sub').textContent = '只读 · ' + srcLabel();
  }

  function doSearch() {
    var term = ($('#q').value || '').trim(), box = $('#searchHits');
    if (!term) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = '<div class="loading">搜索中…</div>';
    doSearchApi(term).then(function (d) {
      var kps = d.kps || [], terms = d.terms || [], html = '';
      if (kps.length) {
        html += '<div class="sec">知识点（点一下进入那一章）' + (settings().mode === 'gh' ? '　—— 离线检索：只含已下载的课程' : '') + '</div>';
        html += kps.map(function (h) {
          return '<div class="hit tap" data-course="' + esc(h.course) + '" data-chapter="' + esc(h.chapter) + '">' +
            '<div class="t">' + esc(h.name) + '</div><div class="c">' + esc([h.course, h.chapter].filter(Boolean).join(' · ')) + '</div>' +
            (h.summary ? '<div class="c sm">' + esc(h.summary) + '…</div>' : '') + '</div>';
        }).join('');
      }
      if (terms.length) {
        html += '<div class="sec">术语频次（来自 知识点总索引.json）</div>';
        html += terms.map(function (h) {
          return '<div class="hit"><div class="t">' + esc(h.term) + '</div><div class="c">出现 ' + (h.count || 0) + ' 次 · ' +
            esc((h.courses || []).join('、')) + '</div></div>';
        }).join('');
      }
      box.innerHTML = html || '<div class="empty">没有匹配。GitHub 模式下只能搜**已下载**的课程 —— 先在设置里点「立即同步」。</div>';
    }).catch(function (e) { box.innerHTML = '<div class="empty">搜索失败：' + esc(e.message) + '</div>'; });
  }

  // ── 设置面板 ─────────────────────────────────────────────────────
  function openSheet() {
    var s = settings();
    $('#owner').value = s.owner || ''; $('#repo').value = s.repo || '';
    $('#branch').value = s.branch || 'master'; $('#token').value = s.token || '';
    document.querySelectorAll('input[name=mode]').forEach(function (r) { r.checked = (r.value === s.mode); });
    $('#ghFields').hidden = (s.mode !== 'gh');
    $('#sheet').hidden = false;
    cacheInfo();
  }
  function closeSheet() { $('#sheet').hidden = true; }

  function cacheInfo() {
    kvKeys().then(function (ks) {
      var packs = ks.filter(function (k) { return String(k).indexOf('gh/') === 0; });
      $('#setStatus').textContent = '本地已缓存包：' + packs.length + ' 个（GitHub 模式可离线读这些课程）';
    });
  }

  function saveAndApply() {
    var mode = 'pc';
    document.querySelectorAll('input[name=mode]').forEach(function (r) { if (r.checked) mode = r.value; });
    saveSettings({
      mode: mode, owner: $('#owner').value.trim(), repo: $('#repo').value.trim(),
      branch: ($('#branch').value.trim() || 'master'), token: $('#token').value.trim()
    });
    state.manifest = null;
    closeSheet();
    goHome();
    loadHome(true);
  }

  /** 立即同步（GitHub 模式）：把 manifest 里所有课程的包都拉下来，供离线用。 */
  function syncAll() {
    var st = $('#setStatus');
    ghTree(true).then(function (d) {
      var names = (d.courses || []).map(function (c) { return c.name; });
      st.textContent = '开始同步 ' + names.length + ' 门课…';
      var done = 0;
      return names.reduce(function (chain, n) {
        return chain.then(function () {
          st.textContent = '正在同步 ' + (++done) + '/' + names.length + '：' + n + '…';
          return ghCourse(n).then(function () {}, function (e) { st.textContent = '同步 ' + n + ' 失败：' + e.message; });
        });
      }, Promise.resolve()).then(function () {
        st.textContent = '同步完成 ✓ ' + names.length + ' 门课';
        cacheInfo();
      });
    }).catch(function (e) { st.textContent = '同步失败：' + e.message; });
  }

  // ── 事件绑定 ─────────────────────────────────────────────────────
  document.addEventListener('click', function (ev) {
    var hit = ev.target.closest ? ev.target.closest('.hit[data-course]') : null;
    if (hit && hit.dataset.chapter) { openChapter(hit.dataset.course, hit.dataset.chapter); return; }
    var ch = ev.target.closest ? ev.target.closest('.ch') : null;
    if (ch) { openChapter(ch.dataset.course, ch.dataset.chapter); return; }
    var tab = ev.target.closest ? ev.target.closest('.tab') : null;
    if (tab) { document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('on', t === tab); }); renderTab(tab.dataset.tab); }
  });
  $('#back').addEventListener('click', goHome);
  $('#qbtn').addEventListener('click', doSearch);
  $('#q').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
  $('#src').addEventListener('click', openSheet);
  $('#closeSet').addEventListener('click', closeSheet);
  $('#saveSet').addEventListener('click', saveAndApply);
  $('#syncNow').addEventListener('click', syncAll);
  $('#refresh').addEventListener('click', function () { goHome(); loadHome(true); });
  document.querySelectorAll('input[name=mode]').forEach(function (r) {
    r.addEventListener('change', function () { $('#ghFields').hidden = (r.value !== 'gh' || !r.checked); });
  });

  // ── 首次登录（A 方案：只读令牌）────────────────────────────────
  // 判定"要不要先登录"：没有 GitHub 令牌，且当前不是从电脑的局域网服务打开。
  // 局域网模式（/m/）由服务端令牌兜底，不需要这一层。
  function servedFromPc() {
    return location.pathname.indexOf('/m') === 0 || location.port === '7711';
  }
  function needLogin() {
    var s = settings();
    return !servedFromPc() && !(s.mode === 'gh' && s.token);
  }

  function showLogin() {
    var s = settings();
    $('#lgOwner').value = s.owner || 'mist1494732214';
    $('#lgRepo').value = s.repo || 'medkb-private';
    $('#lgToken').value = s.token || '';
    $('#login').hidden = false;
    $('#lgStatus').textContent = '';
  }

  function hideLogin() { $('#login').hidden = true; }

  /** 校验令牌 + 仓库可读（打 api.github.com），成功后存设置并加载。 */
  function doLogin() {
    var owner = $('#lgOwner').value.trim();
    var repo = $('#lgRepo').value.trim();
    var token = $('#lgToken').value.trim();
    var st = $('#lgStatus');
    if (!owner || !repo || !token) { st.textContent = '三样都要填。'; return; }
    st.textContent = '正在验证令牌…';
    $('#lgGo').disabled = true;
    fetch('https://api.github.com/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo), {
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
                 'X-GitHub-Api-Version': '2022-11-28' }
    }).then(function (r) {
      if (r.status === 401) throw new Error('令牌无效或已过期（401）');
      if (r.status === 404) throw new Error('读不到这个仓库（404）：检查用户名/仓库名，或令牌没勾这个仓库');
      if (!r.ok) throw new Error('GitHub 返回 ' + r.status);
      return r.json();
    }).then(function (j) {
      if (j.private === false) {
        st.textContent = '⚠ 这个仓库是公开的 —— 令牌不给也能读，确认一下是不是选错了仓库';
      }
      return fetch('https://api.github.com/repos/' + encodeURIComponent(owner) + '/' +
                   encodeURIComponent(repo) + '/contents/_sync/manifest.json?ref=' +
                   encodeURIComponent((settings().branch || 'master')), {
        headers: { 'Authorization': 'Bearer ' + token,
                   'Accept': 'application/vnd.github.raw+json',
                   'X-GitHub-Api-Version': '2022-11-28' }
      });
    }).then(function (r) {
      if (r.status === 404) {
        throw new Error('仓库里没有 _sync/manifest.json —— 先在电脑上讲一章并落库推送，离线包就会生成');
      }
      if (!r.ok) throw new Error('读取离线包清单失败：HTTP ' + r.status);
      saveSettings({ mode: 'gh', owner: owner, repo: repo, token: token,
                     branch: settings().branch || 'master' });
      state.manifest = null;
      hideLogin();
      goHome();
      loadHome(true);
      st.textContent = '';
    }).catch(function (e) {
      st.textContent = '✗ ' + e.message;
    }).then(function () { $('#lgGo').disabled = false; });
  }

  // ── 启动 ─────────────────────────────────────────────────────────
  readToken();

  // 只读调试钩子（与 web/cloud.js 的 window.__zc 同一惯例）：
  // 便于在 Node/控制台里直接调数据层自测（M2 的 GitHub 模式就是这么验的），
  // **只暴露只读能力**，没有任何写操作。
  window.__zs = {
    settings: settings, saveSettings: saveSettings,
    listTree: listTree, getChapter: getChapter, search: doSearchApi,
    packPath: packPath, state: state
  };

  if (needLogin()) {
    showLogin();
  } else {
    loadHome(false);
  }

  // 登录卡按钮
  $('#lgGo').addEventListener('click', doLogin);
  $('#lgToken').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); doLogin(); }
  });
  $('#lgLan').addEventListener('click', function () {
    var st = $('#lgStatus');
    st.textContent = '局域网模式需要电脑开着并在同一 Wi-Fi；也可以用现在的地址直接打开 /m/。';
    saveSettings({ mode: 'pc' });
    hideLogin();
    goHome();
    loadHome(true);
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(function () { console.log('[籽三] 离线外壳已启用'); })
      .catch(function (e) { console.warn('[籽三] 离线外壳不可用（局域网 http 不是安全上下文）：', e); });
  }
})();
