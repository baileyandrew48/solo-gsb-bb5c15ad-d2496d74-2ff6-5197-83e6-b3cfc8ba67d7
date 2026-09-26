'use strict';

/* ================= 全局状态 ================= */
const state = {
  project: null,
  activeId: null,          // 当前高亮的批注
  pickAnnId: null,         // 正在人工框选定位的批注 id
  pickOff: null,           // 人工框选已记录的坐标
  noteTimers: new Map(),
};

const $ = (sel) => document.querySelector(sel);
const els = {};

document.addEventListener('DOMContentLoaded', init);

/* ================= 工具 ================= */
async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const res = await fetch(url, opt);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

let toastTimer = null;
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

function setSaved() {
  const d = new Date();
  $('#saveStatus').textContent = '已保存 ' + d.toLocaleTimeString('zh-CN', { hour12: false });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function statusOf(a) {
  return a.result ? a.result.status : null;
}

/* ================= 启动 ================= */
function init() {
  bindEvents();
  showStart();
}

async function showStart() {
  $('#workspace').classList.add('hidden');
  $('#startScreen').classList.remove('hidden');
  await refreshProjectList();
}

async function refreshProjectList() {
  const projects = await api('GET', '/api/projects');
  const sel = $('#projectSelect');
  sel.innerHTML = '';
  const opt0 = document.createElement('option');
  opt0.value = '';
  opt0.textContent = '— 选择项目 —';
  sel.appendChild(opt0);

  const tbody = $('#projectTable tbody');
  tbody.innerHTML = '';
  $('#emptyProjects').classList.toggle('hidden', projects.length > 0);
  for (const p of projects) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.title;
    sel.appendChild(o);

    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${esc(p.title)}</td>` +
      `<td>${p.annotationCount}</td>` +
      `<td>${p.pendingCount ? `<b style="color:#c62828">${p.pendingCount}</b>` : 0}</td>` +
      `<td>${fmtTime(p.updatedAt)}</td>` +
      `<td><button class="small">打开</button></td>`;
    tr.addEventListener('click', () => openProject(p.id));
    tbody.appendChild(tr);
  }
}

async function openProject(id) {
  state.project = await api('GET', `/api/projects/${id}`);
  state.activeId = null;
  state.pickAnnId = null;
  $('#projectSelect').value = id;
  $('#startScreen').classList.add('hidden');
  $('#workspace').classList.remove('hidden');
  switchTab('old');
  renderAll();
}

function closeProject() {
  state.project = null;
  state.activeId = null;
  state.pickAnnId = null;
  hidePopup();
  showStart();
}

/* ================= 事件绑定 ================= */
function bindEvents() {
  $('#startCreateBtn').addEventListener('click', createProject);
  $('#startTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') createProject(); });
  $('#newProjectBtn').addEventListener('click', createProject);
  $('#projectSelect').addEventListener('change', (e) => { if (e.target.value) openProject(e.target.value); });
  $('#deleteProjectBtn').addEventListener('click', async () => {
    if (!state.project) return;
    if (!confirm(`确定删除项目「${state.project.title}」？全部文稿与批注将被删除且不可恢复。`)) return;
    await api('DELETE', `/api/projects/${state.project.id}`);
    toast('项目已删除');
    closeProject();
  });

  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  // 旧稿
  $('#firstLoadOldBtn').addEventListener('click', loadFirstOldText);
  $('#showOldPasteBtn').addEventListener('click', () => {
    $('#oldPasteArea').value = state.project.oldText;
    $('#oldPasteBox').classList.remove('hidden');
    $('#oldTextView').classList.add('hidden');
    $('#oldPasteArea').focus();
  });
  $('#cancelOldPasteBtn').addEventListener('click', () => {
    $('#oldPasteBox').classList.add('hidden');
    $('#oldTextView').classList.remove('hidden');
  });
  $('#loadOldBtn').addEventListener('click', replaceOldText);

  const oldView = $('#oldTextView');
  oldView.addEventListener('mouseup', onOldSelection);
  oldView.addEventListener('click', onHighlightClick);

  $('#selConfirm').addEventListener('click', confirmCreateAnnotation);
  $('#selCancel').addEventListener('click', hidePopup);
  document.addEventListener('mousedown', (e) => {
    const popup = $('#selPopup');
    if (!popup.classList.contains('hidden') && !popup.contains(e.target) && !e.target.closest('mark')) {
      // 点击弹层外部：延迟判定，避免选区操作冲突
      setTimeout(() => { if (!window.getSelection().toString()) hidePopup(); }, 0);
    }
  });

  $('#oldAnnotationList').addEventListener('input', onNoteInput);
  $('#oldAnnotationList').addEventListener('click', onOldListClick);

  // 新稿
  $('#migrateBtn').addEventListener('click', runFirstMigrate);
  $('#changeNewBtn').addEventListener('click', () => {
    $('#newPasteArea').value = state.project.newText;
    $('#migratePane').classList.add('hidden');
    $('#newPastePane').classList.remove('hidden');
  });
  $('#remigrateBtn').addEventListener('click', forceRemigrate);

  const newView = $('#newTextView');
  newView.addEventListener('click', onHighlightClick);
  newView.addEventListener('mouseup', () => {
    // 人工定位模式下，框选一结束即记录坐标，避免点击按钮时选区被折叠
    if (!state.pickAnnId) return;
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.toString()) return;
    const range = sel.getRangeAt(0);
    if (!newView.contains(range.commonAncestorContainer)) return;
    const off = selectionOffsets(newView, range);
    if (off && off.start !== off.end) {
      state.pickOff = off;
      $('#pickConfirmBtn').textContent = `确认位置（已选 ${off.end - off.start} 字）`;
    }
  });
  $('#pickConfirmBtn').addEventListener('click', confirmPick);
  $('#pickCancelBtn').addEventListener('click', cancelPick);

  $('#resultList').addEventListener('click', onResultListClick);
  $('#filterPending').addEventListener('change', renderResultList);
}

/* ================= 项目 ================= */
async function createProject() {
  const title = ($('#startTitle').value || '').trim();
  const p = await api('POST', '/api/projects', { title });
  toast('项目已创建');
  await openProject(p.id);
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.getElementById('tab-old').classList.toggle('active', name === 'old');
  document.getElementById('tab-new').classList.toggle('active', name === 'new');
  state.activeId = null;
  if (name === 'new' && state.project) prepareNewTab();
  renderAll();
}

/* ================= 旧稿 ================= */
async function loadFirstOldText() {
  const text = $('#oldFirstPaste').value;
  if (!text.trim()) return toast('请先粘贴旧版文稿');
  state.project = await api('PATCH', `/api/projects/${state.project.id}`, { oldText: text });
  setSaved();
  renderAll();
  toast('旧稿已载入，可在正文中框选文字添加批注');
}

async function replaceOldText() {
  const text = $('#oldPasteArea').value;
  if (!text.trim()) return toast('文稿内容为空');
  if (state.project.annotations.length > 0) {
    if (!confirm('更换旧稿将清空全部批注与定位结果，确定继续？')) return;
  }
  state.project = await api('PATCH', `/api/projects/${state.project.id}`, { oldText: text });
  setSaved();
  renderAll();
  toast('旧稿已更换，批注已清空');
}

function onOldSelection() {
  const p = state.project;
  if (!p || !p.oldText) return;
  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.toString()) return;
  const range = sel.getRangeAt(0);
  const view = $('#oldTextView');
  if (!view.contains(range.commonAncestorContainer)) return;
  const off = selectionOffsets(view, range);
  if (!off || off.start === off.end) return;
  showPopup(range, off.start, off.end);
}

function showPopup(range, start, end) {
  const popup = $('#selPopup');
  popup.dataset.start = start;
  popup.dataset.end = end;
  $('#selNote').value = '';
  $('#selAuthor').value = '';
  popup.classList.remove('hidden');
  const rect = range.getBoundingClientRect();
  let top = rect.bottom + 6;
  let left = rect.left;
  if (top + popup.offsetHeight > window.innerHeight - 10) top = rect.top - popup.offsetHeight - 6;
  left = Math.max(8, Math.min(left, window.innerWidth - popup.offsetWidth - 8));
  popup.style.top = top + 'px';
  popup.style.left = left + 'px';
}
function hidePopup() { $('#selPopup').classList.add('hidden'); window.getSelection().removeAllRanges(); }

async function confirmCreateAnnotation() {
  const popup = $('#selPopup');
  const start = Number(popup.dataset.start);
  const end = Number(popup.dataset.end);
  const note = $('#selNote').value;
  const author = $('#selAuthor').value;
  const a = await api('POST', `/api/projects/${state.project.id}/annotations`, { start, end, note, author });
  state.project.annotations.push(a);
  hidePopup();
  setSaved();
  // 若已载入新稿，后台补做迁移（保留已有结果）
  if (state.project.newText) {
    state.project = await api('POST', `/api/projects/${state.project.id}/migrate`, {});
  }
  state.activeId = a.id;
  renderAll();
}

async function onNoteInput(e) {
  const ta = e.target.closest('.note-edit');
  if (!ta) return;
  const id = ta.dataset.id;
  if (state.noteTimers.has(id)) clearTimeout(state.noteTimers.get(id));
  const timer = setTimeout(async () => {
    await api('PATCH', `/api/projects/${state.project.id}/annotations/${id}`, { note: ta.value });
    const a = state.project.annotations.find((x) => x.id === id);
    if (a) a.note = ta.value;
    setSaved();
  }, 500);
  state.noteTimers.set(id, timer);
}

async function onOldListClick(e) {
  const btn = e.target.closest('button[data-act]');
  const card = e.target.closest('.ann-card');
  if (!card) return;
  const id = card.dataset.id;
  if (btn && btn.dataset.act === 'delete') {
    if (!confirm('确定删除这条批注？')) return;
    await api('DELETE', `/api/projects/${state.project.id}/annotations/${id}`);
    state.project.annotations = state.project.annotations.filter((x) => x.id !== id);
    if (state.activeId === id) state.activeId = null;
    setSaved();
    renderAll();
    return;
  }
  activate(id, 'oldTextView', 'oldAnnotationList');
}

/* ================= 新稿迁移 ================= */
async function runFirstMigrate() {
  const text = $('#newPasteArea').value;
  if (!text.trim()) return toast('请先粘贴新版文稿');
  // PATCH 时服务端自动做迁移
  state.project = await api('PATCH', `/api/projects/${state.project.id}`, { newText: text });
  setSaved();
  await prepareNewTab(true);
  const summary = summarize();
  toast(`迁移完成：定位 ${summary.located + summary.manual} 条，待处理 ${summary.pending} 条`, 3000);
}

async function forceRemigrate() {
  const hasManual = state.project.annotations.some((a) => statusOf(a) === 'manual');
  if (hasManual && !confirm('重新定位会清除全部人工确认的位置，确定继续？')) return;
  state.project = await api('POST', `/api/projects/${state.project.id}/migrate`, { force: true });
  setSaved();
  renderAll();
  const s = summarize();
  toast(`重新定位完成：定位 ${s.located + s.manual} 条，待处理 ${s.pending} 条`, 3000);
}

async function prepareNewTab(justMigrated) {
  if (!state.project.newText) {
    $('#newPastePane').classList.remove('hidden');
    $('#migratePane').classList.add('hidden');
    return;
  }
  $('#newPastePane').classList.add('hidden');
  $('#migratePane').classList.remove('hidden');
  // 新增批注尚未迁移时自动补迁移（不影响已人工确认项）
  const missing = state.project.annotations.some((a) => !a.result);
  if (!justMigrated && missing) {
    state.project = await api('POST', `/api/projects/${state.project.id}/migrate`, {});
    setSaved();
  }
  cancelPick();
  renderAll();
}

function enterPickMode(annId) {
  state.pickAnnId = annId;
  state.pickOff = null;
  state.activeId = annId;
  $('#pickConfirmBtn').textContent = '确认位置';
  $('#pickBanner').classList.remove('hidden');
  window.getSelection().removeAllRanges();
  $('#newTextView').focus();
  renderAll();
  toast('请在新稿中框选正确位置后，点击上方「确认位置」', 3000);
}
function cancelPick() {
  state.pickAnnId = null;
  state.pickOff = null;
  $('#pickBanner').classList.add('hidden');
  $('#pickConfirmBtn').textContent = '确认位置';
}

async function confirmPick() {
  const annId = state.pickAnnId;
  if (!annId) return;
  const off = state.pickOff;
  if (!off) return toast('请先在新稿中框选文字');
  const a = await api('POST', `/api/projects/${state.project.id}/annotations/${annId}/manual-locate`, {
    start: off.start, end: off.end,
  });
  mergeAnnotation(a);
  state.pickAnnId = null;
  state.pickOff = null;
  $('#pickBanner').classList.add('hidden');
  $('#pickConfirmBtn').textContent = '确认位置';
  window.getSelection().removeAllRanges();
  setSaved();
  toast('位置已按人工选择保存');
  renderAll();
}

function mergeAnnotation(a) {
  const idx = state.project.annotations.findIndex((x) => x.id === a.id);
  if (idx >= 0) state.project.annotations[idx] = a; else state.project.annotations.push(a);
}

async function onResultListClick(e) {
  const card = e.target.closest('.ann-card');
  if (!card) return;
  const id = card.dataset.id;
  const btn = e.target.closest('button[data-act]');

  if (btn) {
    if (btn.dataset.act === 'pick') return enterPickMode(id);
    if (btn.dataset.act === 'use-candidate') {
      const start = Number(btn.dataset.start);
      const end = Number(btn.dataset.end);
      const a = await api('POST', `/api/projects/${state.project.id}/annotations/${id}/manual-locate`, { start, end });
      mergeAnnotation(a);
      setSaved();
      toast('已按候选位置人工确认');
      renderAll();
      return;
    }
    if (btn.dataset.act === 'reviewed') {
      const a = await api('POST', `/api/projects/${state.project.id}/annotations/${id}/mark-pending`, {});
      mergeAnnotation(a);
      setSaved();
      renderAll();
      return;
    }
  }
  activate(id, 'newTextView', 'resultList');
}

/* ================= 高亮与选区坐标 ================= */
// 扫描容器内所有文本节点，返回 range 在纯文本坐标中的起止
function selectionOffsets(view, range) {
  const walker = document.createTreeWalker(view, NodeFilter.SHOW_TEXT, null);
  let start = null;
  let end = null;
  let acc = 0;
  let node;
  while ((node = walker.nextNode())) {
    const len = node.nodeValue.length;
    if (node === range.startContainer) start = acc + range.startOffset;
    if (node === range.endContainer) end = acc + range.endOffset;
    acc += len;
  }
  if (start === null || end === null) return null;
  if (start > end) [start, end] = [end, start];
  return { start, end };
}

const PRIORITY = { pending: 0, manual: 1, located: 2 };

// 依据区间在 textView 中渲染高亮（允许重叠：切分后按优先级取一个属主，全部 id 记录在 data-anns）
function renderHighlights(viewId, text, ranges, activeId) {
  const view = document.getElementById(viewId);
  if (!text) { view.innerHTML = ''; return; }
  if (!ranges.length) { view.textContent = text; return; }

  const points = new Set([0, text.length]);
  ranges.forEach((r) => { points.add(r.start); points.add(r.end); });
  const pts = [...points].sort((a, b) => a - b);

  let html = '';
  for (let i = 0; i < pts.length - 1; i++) {
    const s = pts[i];
    const e = pts[i + 1];
    const owners = ranges.filter((r) => r.start <= s && r.end >= e && r.end > r.start);
    const piece = esc(text.slice(s, e));
    if (!owners.length) { html += piece; continue; }
    let owner;
    if (owners.some((o) => o.id === activeId)) owner = owners.find((o) => o.id === activeId);
    else owner = owners.reduce((a, b) => (PRIORITY[a.cls] <= PRIORITY[b.cls] ? a : b));
    const cls = owner.id === activeId ? 'active' : owner.cls;
    const ids = owners.map((o) => o.id).join(',');
    html += `<mark class="ann ${cls}" data-owner="${owner.id}" data-anns="${ids}">${piece}</mark>`;
  }
  view.innerHTML = html;
}

function onHighlightClick(e) {
  const mark = e.target.closest('mark.ann');
  if (!mark) return;
  const id = mark.dataset.owner || mark.dataset.anns.split(',')[0];
  const inNew = e.currentTarget.id === 'newTextView';
  activate(id, inNew ? 'newTextView' : 'oldTextView', inNew ? 'resultList' : 'oldAnnotationList');
}

function activate(id, viewId, listId) {
  state.activeId = id;
  renderAll();
  const list = document.getElementById(listId);
  const card = list.querySelector(`.ann-card[data-id="${id}"]`);
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  const view = document.getElementById(viewId);
  const marks = view.querySelectorAll(`mark.ann[data-anns*="${id}"]`);
  if (marks.length) marks[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ================= 渲染 ================= */
function renderAll() {
  if (!state.project) return;
  const p = state.project;

  // 旧稿区域
  const hasOld = !!p.oldText;
  const pasteOpen = !$('#oldPasteBox').classList.contains('hidden');
  $('#oldEmptyHint').classList.toggle('hidden', hasOld);
  $('#oldTextView').classList.toggle('hidden', !hasOld || pasteOpen);
  if (hasOld) {
    const ranges = p.annotations.map((a) => ({
      id: a.id,
      start: a.start,
      end: a.end,
      cls: mapStatusClass(a.result),
    }));
    renderHighlights('oldTextView', p.oldText, ranges, state.activeId);
  }
  renderOldList();

  // 新稿区域
  if (p.newText) {
    const ranges = p.annotations
      .filter((a) => a.result && (a.result.status === 'located' || a.result.status === 'manual'))
      .map((a) => ({ id: a.id, start: a.result.start, end: a.result.end, cls: a.result.status }));
    renderHighlights('newTextView', p.newText, ranges, state.activeId);
    renderSummary();
    renderResultList();
  }
}

function mapStatusClass(result) {
  if (!result) return 'located';
  if (result.status === 'located') return 'located';
  if (result.status === 'manual') return 'manual';
  return 'pending';
}

function renderOldList() {
  const list = $('#oldAnnotationList');
  const p = state.project;
  $('#oldCount').textContent = p.annotations.length;
  list.innerHTML = '';
  if (!p.annotations.length) {
    list.innerHTML = '<p class="muted" style="padding:10px">在左侧正文中按住鼠标框选文字，即可添加批注。</p>';
    return;
  }
  for (const a of p.annotations) {
    const card = document.createElement('div');
    card.className = 'ann-card ' + (a.result ? mapStatusClass(a.result) : 'located') + (state.activeId === a.id ? ' active' : '');
    card.dataset.id = a.id;
    const tag = statusTagHtml(a);
    card.innerHTML =
      `<div class="meta">${tag}<span>${esc(a.author || '未署名')}</span><span>${fmtTime(a.createdAt)}</span></div>` +
      `<div class="quote">${esc(a.quote)}</div>` +
      `<textarea class="note-edit" data-id="${a.id}" placeholder="批注内容">${esc(a.note || '')}</textarea>` +
      `<div class="card-actions"><button class="small danger" data-act="delete">删除批注</button></div>`;
    list.appendChild(card);
  }
}

function summarize() {
  const s = { located: 0, manual: 0, pending: 0, fresh: 0 };
  for (const a of state.project.annotations) {
    const st = statusOf(a);
    if (st === 'located') s.located++;
    else if (st === 'manual') s.manual++;
    else if (st === 'pending') s.pending++;
    else s.fresh++;
  }
  return s;
}

function renderSummary() {
  const s = summarize();
  const total = state.project.annotations.length;
  $('#resultSummary').innerHTML =
    `共 ${total} 条批注：<b class="located">自动定位 ${s.located}</b> · <b class="manual">人工确认 ${s.manual}</b> · <b class="pending">待处理 ${s.pending}</b>` +
    (s.fresh ? ` · <span class="muted">未迁移 ${s.fresh}</span>` : '');
}

function statusTagHtml(a) {
  const st = statusOf(a);
  if (st === 'located') {
    const fz = a.result.matchType === 'fuzzy' ? '（忽略空白差异）' : '';
    return `<span class="tag located">已定位${fz}</span>`;
  }
  if (st === 'manual') return `<span class="tag manual">人工确认</span>`;
  if (st === 'pending') {
    const reason = a.result.reason === 'deleted' ? '原文已删除' : '多处可能';
    const reviewed = a.result.reviewed ? '·已核对' : '';
    return `<span class="tag pending">待处理：${reason}${reviewed}</span>`;
  }
  return '<span class="tag located" style="background:#e9ecef;color:#656d76">未迁移</span>';
}

function ctxHtml(text, start, end) {
  const pre = esc(text.slice(Math.max(0, start - 16), start));
  const hit = esc(text.slice(start, end));
  const post = esc(text.slice(end, end + 16));
  return `<div class="context">……${pre}<span class="hit">${hit}</span>${post}……</div>`;
}

function renderResultList() {
  const list = $('#resultList');
  const p = state.project;
  list.innerHTML = '';
  const onlyPending = $('#filterPending').checked;
  const items = p.annotations
    .slice()
    .sort((a, b) => {
      const rank = (x) => (statusOf(x) === 'pending' ? 0 : 1);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return resultStart(a) - resultStart(b);
    })
    .filter((a) => !onlyPending || statusOf(a) === 'pending');

  if (!items.length) {
    list.innerHTML = onlyPending
      ? '<p class="muted" style="padding:10px">没有待处理批注，全部已定位 🎉</p>'
      : '<p class="muted" style="padding:10px">暂无批注。</p>';
    return;
  }

  for (const a of items) {
    const card = document.createElement('div');
    const st = statusOf(a);
    card.className = 'ann-card ' + (st || 'located') + (state.activeId === a.id ? ' active' : '');
    card.dataset.id = a.id;

    let body =
      `<div class="meta">${statusTagHtml(a)}<span>${esc(a.author || '未署名')}</span></div>` +
      `<div class="quote" title="旧稿原文">${esc(a.quote)}</div>`;
    if (a.note) body += `<div class="context">📝 ${esc(a.note)}</div>`;

    if (st === 'located' || st === 'manual') {
      body += ctxHtml(p.newText, a.result.start, a.result.end);
      body += `<div class="context">${st === 'located' ? `上下文相似度 ${(a.result.score * 100).toFixed(0)}%` : '由校对员人工选定'}</div>`;
      body += `<div class="card-actions"><button class="small" data-act="pick">✂️ 人工改选位置</button></div>`;
    } else if (st === 'pending') {
      if (a.result.reason === 'deleted') {
        body += `<div class="reason">新版文稿中未找到该段文字，可能已删除或被大幅改写。</div>`;
      } else {
        body += `<div class="reason">新版中存在多个可能位置，上下文不足以自动判定，请人工确认：</div>`;
        body += `<div class="cand-list">`;
        for (const c of (a.result.candidates || [])) {
          body +=
            `<button class="cand" data-act="use-candidate" data-start="${c.start}" data-end="${c.end}">` +
            `……${esc(c.snippetPre)}<span class="hit">${esc(p.newText.slice(c.start, c.end))}</span>${esc(c.snippetPost)}……` +
            ` <span class="score">${(c.score * 100).toFixed(0)}%</span>` +
            (c.fuzzy ? ' <span class="muted">空白差异</span>' : '') +
            `</button>`;
        }
        body += `</div>`;
      }
      body +=
        `<div class="card-actions">` +
        `<button class="small primary" data-act="pick">✂️ 在新稿框选位置</button>` +
        `<button class="small" data-act="reviewed">已核对，保持待处理</button>` +
        `</div>`;
    } else {
      body += `<div class="reason">尚未在新稿中迁移。</div>`;
    }
    card.innerHTML = body;
    list.appendChild(card);
  }
}

function resultStart(a) {
  return a.result && typeof a.result.start === 'number' ? a.result.start : Number.MAX_SAFE_INTEGER;
}
