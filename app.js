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
      return { ok: true, course: course, chapter: chapter, note: hit.note || '', qa: hit.qa || '',
               kps: hit.kps || [], exercises: hit.exercises || {} };
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
    } else if (tab === 'practice') {
      el.innerHTML = renderPractice();
    } else if (tab === 'deep') {
      el.innerHTML = renderDeep();
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


  // ══════════════════════════════════════════════════════════════════
  //  练习（离线）：挖空 / 选择题 / 闪卡 —— 数据来自离线包的 exercises
  // ══════════════════════════════════════════════════════════════════
  var PR = { game: 'cloze', ci: 0, picked: -1, right: 0, total: 0, showAns: {} };

  function exercises() {
    return (state.data && state.data.exercises) || {};
  }
  function norm(s) {
    return String(s || '').toLowerCase()
      .replace(/[\s　]/g, '').replace(/[，,。；;、：:（）()]/g, '')
      .replace(/[－—–~～]/g, '-');
  }

  function renderPractice() {
    var ex = exercises();
    var g = PR.game;
    var html = '<div class="pbar">' +
      ['cloze', 'choice', 'cards', 'socratic', 'feynman'].map(function (k) {
        var name = { cloze: '挖空', choice: '选择题', cards: '五联卡',
                     socratic: '考官', feynman: '费曼' }[k];
        return '<button class="pbtn' + (g === k ? ' on' : '') + '" data-pg="' + k + '">' + name + '</button>';
      }).join('') +
      (g === 'choice' ? '<span class="pscore">答对 ' + PR.right + ' / ' + PR.total + '</span>' : '') +
      '</div>';
    if (g === 'cloze') html += pCloze(ex.cloze || []);
    else if (g === 'choice') html += pChoice(ex.choice || []);
    else if (g === 'socratic' || g === 'feynman') html += pChat(g);
    else html += pCards(ex.cards || []);
    return html;
  }

  function pCloze(items) {
    if (!items.length) return '<div class="empty">这一章还没有挖空题（需要更完整的笔记标签）</div>';
    var i = Math.min(PR.ci, items.length - 1);
    var it = items[i];
    var parts = String(it.text).split(/\{\{(\d+)\}\}/);
    var body = '';
    parts.forEach(function (seg) {
      if (/^\d+$/.test(seg)) {
        var k = Number(seg), want = (it.answers || [])[k] || '';
        body += '<input class="blk" data-idx="' + k + '" size="' + Math.max(5, Math.min(12, want.length + 1)) +
          '" autocomplete="off" autocapitalize="off" spellcheck="false">';
      } else if (seg) body += esc(seg);
    });
    return '<div class="pn">第 ' + (i + 1) + ' / ' + items.length + ' 题' +
      (it.kp ? '　<b>' + esc(it.kp) + '</b>' : '') + '</div>' +
      '<div class="qcard"><div class="cloze">' + body + '</div>' +
      '<div class="pacts"><button class="pbtn pri" data-pcheck="1">对答案</button>' +
      '<button class="pbtn" data-pnext="1">下一题 →</button>' +
      '<span class="pmsg" id="pmsg"></span></div></div>';
  }

  function pChoice(items) {
    if (!items.length) return '<div class="empty">这一章还没有选择题</div>';
    var i = Math.min(PR.ci, items.length - 1);
    var it = items[i];
    var done = PR.picked >= 0;
    var opts = (it.options || []).map(function (o, k) {
      var cls = 'opt';
      if (done) {
        if (k === it.answerIndex) cls += ' ok';
        else if (k === PR.picked) cls += ' bad';
      }
      return '<button class="' + cls + '" data-pick="' + k + '"><b>' + 'ABCD'[k] + '</b>' +
        esc(o) + '</button>';
    }).join('');
    return '<div class="pn">第 ' + (i + 1) + ' / ' + items.length + ' 题</div>' +
      '<div class="qcard"><div class="stem">' + esc(it.stem) + '</div>' + opts +
      (done ? '<div class="exp">' + esc(it.explain || '') + '</div>' : '') +
      '<div class="pacts">' + (done ? '<button class="pbtn pri" data-pnext="1">下一题 →</button>' : '') +
      '</div></div>';
  }

  // ── 接模型（仅局域网模式）─────────────────────────────────────────
  var CH = { msgs: [], busy: false, kind: '' };

  function pcMode() { return servedFromPc(); }

  /** 流式重绘节流（最多 6 次/秒）：一个回答动辄 400+ 事件，逐事件重绘会卡死手机 */
  var _lastPaint = 0, _paintTimer = null;
  function throttlePaint(tab, final) {
    if (final) {
      if (_paintTimer) { clearTimeout(_paintTimer); _paintTimer = null; }
      _lastPaint = Date.now();
      renderTab(tab);
      return;
    }
    var now = Date.now();
    if (now - _lastPaint >= 160) {
      _lastPaint = now;
      renderTab(tab);
    } else if (!_paintTimer) {
      _paintTimer = setTimeout(function () {
        _paintTimer = null;
        _lastPaint = Date.now();
        renderTab(tab);
      }, 170);
    }
  }

  /** POST + 逐块解析 SSE（event: x / data: {...}） */
  function postSSE(path, body, onEvent) {
    fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          var m = t;
          try { m = JSON.parse(t).error || t; } catch (e) {}
          throw new Error(m);
        });
      }
      var reader = res.body.getReader();
      var dec = new TextDecoder('utf-8');
      var buf = '';
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) { onEvent('__end', {}); return; }
          buf += dec.decode(r.value, { stream: true });
          var i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            var chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            var name = 'message', data = '';
            chunk.split('\n').forEach(function (ln) {
              if (ln.indexOf('event: ') === 0) name = ln.slice(7).trim();
              else if (ln.indexOf('data: ') === 0) data += ln.slice(6);
            });
            try { onEvent(name, data ? JSON.parse(data) : {}); } catch (e) {}
          }
          return pump();
        });
      }
      return pump();
    }).catch(function (e) { onEvent('error', { message: e.message }); });
  }

  /** 考官 / 费曼：聊天式多轮，只在本机模式可用（GitHub 模式没有模型） */
  /** 本章知识点名（考官/费曼/纠错的下拉用）——数据来自章节的 kps 列表 */
  function kpNames() {
    var ks = (state.data && state.data.kps) || [];
    return ks.map(function (k) { return typeof k === 'string' ? k : (k && k.name) || ''; })
      .filter(function (n) { return !!n; });
  }

  function pChat(kind) {
    if (!pcMode()) {
      return '<div class="empty">考官与费曼要调模型，<b>只能在「电脑开着 + 局域网模式」下用</b>。<br>' +
        '现在的数据源是 GitHub 离线包（只读静态内容）。<br><br>' +
        '用法：电脑开着籽三 → 手机浏览器打开电脑上的 <code>/m/?token=…</code> 地址；' +
        '在那个页面里练习即可（同一条 WiFi）。</div>';
    }
    if (CH.kind !== kind) { CH = { msgs: [], busy: false, kind: kind }; }
    var names = kpNames();
    var opts = '<option value="">（整章 / 不限）</option>' + names.map(function (n) {
      return '<option value="' + esc(n) + '">' + esc(n) + '</option>';
    }).join('');
    var head = '<div class="chhead"><select id="chKp" class="chsel">' + opts + '</select>' +
      '<button class="pbtn pri" id="chStart">' + (kind === 'socratic' ? '开始出题' : '开始检验') + '</button></div>';
    var body = CH.msgs.map(function (m) {
      if (m.role === 'user') return '<div class="chm u">' + esc(m.text) + '</div>';
      return '<div class="chm a">' + (m.text ? md(m.text) : '<span class="chwait">思考中…</span>') +
        (m.think ? '<details class="chthink"><summary>💭 思考（' + m.think.length + ' 字）</summary><pre>' +
          esc(m.think) + '</pre></details>' : '') + '</div>';
    }).join('');
    return head + '<div class="chlog">' + (body || '<div class="empty" style="padding:14px">' +
      (kind === 'socratic' ? '考官会按本章知识点连续追问，答不上就直说"不会"。'
                           : '先用你自己的话复述一个知识点，再交卷。') + '</div>') + '</div>' +
      '<div class="chbar"><textarea id="chIn" class="chinput" rows="2" placeholder="' +
      (kind === 'socratic' ? '回答考官…' : '写下你的复述…') + '"></textarea>' +
      '<button class="pbtn pri" id="chSend">发送</button></div>';
  }

  function chatSend(kind) {
    if (CH.kind !== kind) CH = { msgs: [], busy: false, kind: kind };
    if (CH.busy) return;
    var inp = $('#chIn');
    var text = (inp && inp.value || '').trim();
    var kpSel = $('#chKp');
    var kp = kpSel ? kpSel.value : '';
    if (!text && CH.msgs.length) return;                  // 只在第一次允许空（开场出题）
    CH.busy = true;
    if (text) CH.msgs.push({ role: 'user', text: text });
    var cur = { role: 'assistant', text: '', think: '' };
    CH.msgs.push(cur);
    renderTab('practice');
    postSSE(kind === 'socratic' ? '/m/api/socratic' : '/m/api/feynman',
      { text: text, kp: kp, scope: (state.chapter ? ((state.course || '') + ' / ' + state.chapter) : '') },
      function (ev, d) {
        if (ev === 'text' && d.text) { cur.text += d.text; }
        else if (ev === 'thinking' && d.text) { cur.think += d.text; }
        else if (ev === 'error') { cur.text = (cur.text || '') + '\n\n⚠ ' + (d.message || '出错'); }
        else if (ev === 'notice') {
          var nt = (d.text || d.message || '');
          if (nt) cur.text = (cur.text || '') + (cur.text ? '\n' : '') + '_' + nt + '_';
        }
        else if (ev === 'done' || ev === '__end') { CH.busy = false; throttlePaint('practice', true); return; }
        throttlePaint('practice');
      });
  }

  function pCards(cards) {
    if (!cards.length) return '<div class="empty">这一章还没有五联卡素材</div>';
    var F = [['cause', '病因/诱因'], ['mechanism', '关键机制'], ['gross', '大体'],
             ['micro', '镜下'], ['clinic', '临床联系'], ['outcome', '结局/转归'], ['confuse', '易混点']];
    return '<div class="pn">' + cards.length + ' 张（点开看；在「深度学习」里可以填写）</div>' +
      cards.map(function (c, i) {
        return '<details class="card"' + (i === 0 ? ' open' : '') + '><summary>' + esc(c.kp) + '</summary>' +
          F.map(function (f) {
            var v = c[f[0]];
            return v ? '<div class="cf"><span>' + f[1] + '</span><p>' + esc(v) + '</p></div>' : '';
          }).join('') + '</details>';
      }).join('');
  }

  // ══════════════════════════════════════════════════════════════════
  //  深度学习（离线）：8 阶段 + 五联卡填写 + 检查清单
  // ══════════════════════════════════════════════════════════════════
  function dlKey() { return 'zs_dl_' + (state.course || '') + '|' + (state.chapter || ''); }
  function dlLoad() {
    try { return JSON.parse(localStorage.getItem(dlKey()) || '{}') || {}; } catch (e) { return {}; }
  }
  function dlSave(d) { try { localStorage.setItem(dlKey(), JSON.stringify(d)); } catch (e) {} }

  /** 导出当前这一章的学习进度（JSON，可发给自己/放回电脑） */
  function dlExport() {
    var d = dlLoad();
    var pack = {
      kind: 'ziisan-deep-progress',
      version: 1,
      device: (localStorage.getItem('zs_device') || (function () {
        var n = 'device-' + Math.random().toString(36).slice(2, 8);
        try { localStorage.setItem('zs_device', n); } catch (e) {}
        return n;
      })()),
      exportedAt: new Date().toISOString(),
      course: state.course || '',
      chapter: state.chapter || '',
      dl: d
    };
    var blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '籽三进度_' + (state.course || '') + '_' + (state.chapter || '') + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
    dlMsg('已导出到下载目录');
  }

  function dlMsg(t) {
    var el = $('#dlmsg');
    if (el) el.textContent = t || '';
  }

  /** 把一份进度包合并进本机（按 课程|章节 分键；字段取并集，包里的值优先） */
  function mergePack(pack) {
    if (!pack || pack.kind !== 'ziisan-deep-progress') throw new Error('不是籽三的进度包');
    var key = 'zs_dl_' + (pack.course || '') + '|' + (pack.chapter || '');
    var cur = {};
    try { cur = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (e) {}
    var inc = pack.dl || {};
    ['stages', 'checklist', 'goals'].forEach(function (f) {
      cur[f] = Object.assign({}, cur[f] || {}, inc[f] || {});
    });
    var cards = Object.assign({}, cur.cards || {});
    Object.keys(inc.cards || {}).forEach(function (kp) {
      cards[kp] = Object.assign({}, cards[kp] || {}, inc.cards[kp] || {});
    });
    cur.cards = cards;
    cur.mergedAt = new Date().toISOString();
    try { localStorage.setItem(key, JSON.stringify(cur)); } catch (e) {}
    return key;
  }

  function dlImport(file) {
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var pack = JSON.parse(String(fr.result));
        mergePack(pack);
        dlMsg('已导入：' + (pack.course || '') + ' / ' + (pack.chapter || ''));
        renderTab('deep');
      } catch (e) {
        dlMsg('导入失败：' + e.message);
      }
    };
    fr.readAsText(file, 'utf-8');
  }

  /** 从云端（私有仓库的 学习进度/latest.json）恢复所有章节进度 */
  function dlCloudRestore() {
    dlMsg('正在读云端进度…');
    ghFetch('学习进度/latest.json').then(function (txt) {
      var data = JSON.parse(txt);
      var list = data.entries || data.items || [];
      var n = 0;
      list.forEach(function (e) {
        try { mergePack(e); n++; } catch (err) {}
      });
      dlMsg(n ? ('已恢复 ' + n + ' 条章节进度') : '云端没有可恢复的进度');
      renderTab('deep');
    }).catch(function (e) {
      dlMsg('读不到云端进度：' + e.message);
    });
  }

  var DEEP = { out: '', ans: '', busy: false };

  function deepKbRoot() {
    if (state.kbRoot) return Promise.resolve(state.kbRoot);
    return fetch('/m/api/status').then(function (r) { return r.json(); })
      .then(function (j) { state.kbRoot = j.kb || ''; return state.kbRoot; });
  }

  /** 让籽三讲一遍 / 提交作答纠错（转发给电脑上的主服务） */
  function deepCoach(stage) {
    if (!pcMode() || DEEP.busy) return;
    var kpSel = $('#dpKp');
    var kp = kpSel ? kpSel.value : '';
    var ans = ($('#dpAns') && $('#dpAns').value || '').trim();
    if (stage === 'grade' && !ans) { DEEP.out = '⚠ 先把你的作答写进下面的框，再点纠错。'; renderTab('deep'); return; }
    DEEP.busy = true; DEEP.ans = ans;
    DEEP.out = '思考中…';
    renderTab('deep');
    deepKbRoot().then(function (root) {
      postSSE('/m/api/coach', {
        course: state.course || '', path: root ? (root + '\\' + state.course + '\\' + state.chapter) : '',
        kp: kp, stage: stage, answer: ans
      }, function (ev, d) {
        if (ev === 'text' && d.text) { DEEP.out = (DEEP.out === '思考中…' ? '' : DEEP.out) + d.text; }
        else if (ev === 'error') { DEEP.out = '⚠ ' + (d.message || '出错'); }
        else if (ev === 'done' || ev === '__end') { DEEP.busy = false; throttlePaint('deep', true); return; }
        throttlePaint('deep');
      });
    }).catch(function (e) { DEEP.busy = false; DEEP.out = '⚠ ' + e.message; renderTab('deep'); });
  }

  function renderDeep() {
    var plan = (exercises().plan) || {};
    var cards = exercises().cards || [];
    var d = dlLoad();
    var F = [['cause', '病因/诱因'], ['mechanism', '关键机制'], ['gross', '大体'],
             ['micro', '镜下'], ['clinic', '临床联系'], ['outcome', '结局/转归'], ['confuse', '易混点']];

    var doneStages = (plan.stages || []).filter(function (s) { return (d.stages || {})[s.key]; }).length;
    var filled = 0;
    cards.forEach(function (c) {
      var e = (d.cards || {})[c.kp] || {};
      if (F.some(function (f) { return (e[f[0]] || '').trim(); })) filled++;
    });

    var html = '<div class="dlbar">' +
      '<button class="pbtn" data-dlexp="1">⬇ 导出进度</button>' +
      '<button class="pbtn" data-dlimp="1">⬆ 导入进度</button>' +
      '<button class="pbtn" data-dlcloud="1">☁ 从云端恢复</button>' +
      '<span class="pmsg" id="dlmsg"></span></div>' +
      '<input type="file" id="dlFile" accept=".json,application/json" hidden>' +
      '<div class="dlhead">' + esc(plan.type || '') +
      '　首轮 <b>' + (plan.totalMin || 0) + '</b> 分钟（紧就压到 ' + (plan.shortTotal || 0) + '）' +
      '　·　阶段 <b>' + doneStages + '/' + (plan.stages || []).length + '</b>' +
      '　·　五联卡 <b>' + filled + '/' + cards.length + '</b></div>';

    // 接模型区（仅局域网模式）：讲 + 纠错
    if (pcMode() && cards.length) {
      html += '<div class="dlsec">让籽三讲 / 纠错（需要电脑开着）</div>' +
        '<div class="chhead"><select id="dpKp" class="chsel">' +
        cards.map(function (c) { return '<option value="' + esc(c.kp) + '">' + esc(c.kp) + '</option>'; }).join('') +
        '</select><button class="pbtn pri" id="dpExplain">讲一遍</button>' +
        '<button class="pbtn" id="dpGrade">提交作答·纠错</button></div>' +
        '<div id="dpOut" class="dpout">' + (DEEP.out ? md(DEEP.out) : '') + '</div>' +
        '<textarea id="dpAns" class="chinput" rows="3" placeholder="把你的作答写这里，再点「提交作答·纠错」">' +
        esc(DEEP.ans || '') + '</textarea>';
    } else if (!pcMode()) {
      html += '<div class="dlnote">讲解与纠错要调模型，只在「电脑开着 + 局域网模式」下可用；' +
        '这里的五联卡、阶段、清单都可以离线做。</div>';
    }

    html += '<div class="dlsec">八阶段（勾掉就是做完了）</div><div class="stages">';
    (plan.stages || []).forEach(function (s) {
      var on = !!(d.stages || {})[s.key];
      var act = '';
      if (s.action && s.action.kind === 'practice') {
        act = '<button class="pbtn" data-go="' + esc(s.action.game) + '">' + '去练 →' + '</button>';
      } else if (s.action && s.action.text) {
        act = '<div class="dlhint">' + esc(s.action.text) + '</div>';
      }
      html += '<label class="st' + (on ? ' on' : '') + '"><input type="checkbox" data-st="' + esc(s.key) + '"' +
        (on ? ' checked' : '') + '><span class="min">' + s.min + '′</span>' +
        '<span class="tx"><b>' + esc(s.name) + '</b> ' + esc(s.what) + '</span></label>' +
        (act ? '<div class="stact">' + act + '</div>' : '');
    });
    html += '</div>';

    html += '<div class="dlsec">五联卡（把空的填上，存在手机里）</div>';
    cards.forEach(function (c, i) {
      var e = (d.cards || {})[c.kp] || {};
      html += '<details class="card"' + (i === 0 ? ' open' : '') + '><summary>' + esc(c.kp) + '</summary>' +
        F.map(function (f) {
          var v = (e[f[0]] != null ? e[f[0]] : (c[f[0]] || ''));
          return '<div class="cf"><span>' + f[1] + '</span>' +
            '<textarea rows="2" data-dl="' + esc(c.kp) + '" data-f="' + f[0] + '" ' +
            'placeholder="（待补）">' + esc(v) + '</textarea></div>';
        }).join('') + '</details>';
    });

    html += '<div class="dlsec">完成检查清单</div>';
    (plan.checklist || []).forEach(function (ck) {
      var on = !!(d.checklist || {})[ck.key];
      html += '<label class="st' + (on ? ' on' : '') + '"><input type="checkbox" data-ck="' + esc(ck.key) + '"' +
        (on ? ' checked' : '') + '><span class="tx">' + esc(ck.text) + '</span></label>';
    });
    return html;
  }

  // ══════════════════════════════════════════════════════════════════
  //  事件：练习 / 深度学习 的交互
  // ══════════════════════════════════════════════════════════════════
  function bindPracticeDeep() {
    var box = $('#content');
    if (!box) return;

    box.addEventListener('click', function (e) {
      var t = e.target;
      // 玩法切换
      var pg = t.getAttribute && t.getAttribute('data-pg');
      if (pg) { PR.game = pg; PR.ci = 0; PR.picked = -1; renderTab('practice'); return; }
      // 挖空：对答案 / 下一题
      if (t.getAttribute && t.getAttribute('data-pcheck')) {
        var inputs = box.querySelectorAll('input.blk');
        var items = exercises().cloze || [];
        var it = items[Math.min(PR.ci, items.length - 1)] || { answers: [] };
        var ok = 0, bad = 0;
        Array.prototype.forEach.call(inputs, function (inp) {
          var k = Number(inp.getAttribute('data-idx'));
          var want = (it.answers || [])[k] || '';
          if (!inp.value.trim()) { inp.className = 'blk'; return; }
          if (norm(inp.value) === norm(want)) { inp.className = 'blk ok'; ok++; }
          else { inp.className = 'blk bad'; inp.title = '答案：' + want; bad++; }
        });
        var msg = $('#pmsg');
        if (msg) msg.textContent = bad ? ('对 ' + ok + '、错 ' + bad + '（红框点一下看答案）') : ('✓ 全对（' + ok + '）');
        return;
      }
      if (t.getAttribute && t.getAttribute('data-pnext')) {
        PR.ci += 1; PR.picked = -1;
        renderTab(PR.game === 'choice' ? 'practice' : 'practice');
        return;
      }
      // 选择题：选一项
      var pick = t.getAttribute && t.getAttribute('data-pick');
      if (pick != null && PR.picked < 0) {
        var arr = exercises().choice || [];
        var item = arr[Math.min(PR.ci, arr.length - 1)];
        PR.picked = Number(pick);
        PR.total += 1;
        if (PR.picked === item.answerIndex) PR.right += 1;
        renderTab('practice');
        return;
      }
      // 考官 / 费曼：开场与发送
      if (t.id === 'chStart') { chatSend(PR.game); return; }
      if (t.id === 'chSend') { chatSend(PR.game); return; }
      // 深度学习：讲 / 纠错
      if (t.id === 'dpExplain') { deepCoach('explain'); return; }
      if (t.id === 'dpGrade') { deepCoach('grade'); return; }
      // 学习进度：导出 / 导入 / 云端恢复
      if (t.getAttribute && t.getAttribute('data-dlexp')) { dlExport(); return; }
      if (t.getAttribute && t.getAttribute('data-dlimp')) {
        var fi = $('#dlFile'); if (fi) fi.click(); return;
      }
      if (t.getAttribute && t.getAttribute('data-dlcloud')) { dlCloudRestore(); return; }
      // 深度学习：跳到练习玩法
      var go = t.getAttribute && t.getAttribute('data-go');
      if (go) { PR.game = (go === 'choice' ? 'choice' : 'cloze'); PR.ci = 0; PR.picked = -1; renderTab('practice'); return; }
    });

    box.addEventListener('change', function (e) {
      var t = e.target;
      if (t && t.id === 'dlFile' && t.files && t.files[0]) { dlImport(t.files[0]); return; }
      if (!t || t.type !== 'checkbox') return;
      var d = dlLoad();
      var st = t.getAttribute('data-st'), ck = t.getAttribute('data-ck');
      if (st) { d.stages = d.stages || {}; d.stages[st] = t.checked; }
      if (ck) { d.checklist = d.checklist || {}; d.checklist[ck] = t.checked; }
      dlSave(d);
      var row = t.closest('label');
      if (row) row.classList.toggle('on', t.checked);
    });

    box.addEventListener('input', function (e) {
      var t = e.target;
      if (!t || t.tagName !== 'TEXTAREA' || !t.getAttribute('data-dl')) return;
      var d = dlLoad();
      var kp = t.getAttribute('data-dl'), f = t.getAttribute('data-f');
      d.cards = d.cards || {}; d.cards[kp] = d.cards[kp] || {};
      d.cards[kp][f] = t.value;
      dlSave(d);
    });
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

  bindPracticeDeep();

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
