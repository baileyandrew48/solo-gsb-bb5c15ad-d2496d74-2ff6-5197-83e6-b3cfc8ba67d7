'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const storage = require('./lib/storage');
const { migrateAll } = require('./lib/relocate');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const newId = () => crypto.randomBytes(8).toString('hex');
const now = () => Date.now();

function validText(v) {
  return typeof v === 'string';
}
function makeProject(title) {
  const ts = now();
  return {
    id: newId(),
    title: title || '未命名文稿',
    oldText: '',
    newText: '',
    annotations: [], // {id, start, end, quote, note, author, createdAt, result?}
    createdAt: ts,
    updatedAt: ts,
  };
}
function touch(p) { p.updatedAt = now(); }

// 项目列表
app.get('/api/projects', (req, res) => {
  res.json(storage.listProjects());
});

// 创建项目
app.post('/api/projects', (req, res) => {
  const p = makeProject(req.body && req.body.title);
  storage.putProject(p);
  res.status(201).json(p);
});

// 读取项目
app.get('/api/projects/:id', (req, res) => {
  const p = storage.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  res.json(p);
});

// 删除项目
app.delete('/api/projects/:id', (req, res) => {
  if (!storage.getProject(req.params.id)) return res.status(404).json({ error: '项目不存在' });
  storage.deleteProject(req.params.id);
  res.json({ ok: true });
});

// 更新标题 / 文稿文本
app.patch('/api/projects/:id', (req, res) => {
  const p = storage.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  const b = req.body || {};
  if (b.title !== undefined) {
    if (typeof b.title !== 'string') return res.status(400).json({ error: '标题必须是字符串' });
    p.title = b.title.slice(0, 200);
  }
  // 旧稿文本变更：坐标可能失效，批注与定位结果全部作废（由前端先确认）
  if (b.oldText !== undefined) {
    if (!validText(b.oldText)) return res.status(400).json({ error: '旧稿文本必须是字符串' });
    if (b.oldText !== p.oldText) {
      p.oldText = b.oldText;
      p.annotations = [];
    }
  }
  if (b.newText !== undefined) {
    if (!validText(b.newText)) return res.status(400).json({ error: '新稿文本必须是字符串' });
    p.newText = b.newText;
    // 新稿变更，基于坐标的定位结果失效，需要重新迁移
    if (b.newText !== '') {
      p.annotations = migrateAll(p.annotations, p.oldText, p.newText);
    }
  }
  touch(p);
  storage.putProject(p);
  res.json(p);
});

// 新增批注（在旧稿上）
app.post('/api/projects/:id/annotations', (req, res) => {
  const p = storage.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  const b = req.body || {};
  const start = Number(b.start);
  const end = Number(b.end);
  const note = String(b.note == null ? '' : b.note);
  const author = String(b.author == null ? '' : b.author);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > p.oldText.length) {
    return res.status(400).json({ error: '批注选区坐标无效' });
  }
  const annotation = {
    id: newId(),
    start,
    end,
    quote: p.oldText.slice(start, end),
    note,
    author: author.slice(0, 100),
    createdAt: now(),
  };
  p.annotations.push(annotation);
  touch(p);
  storage.putProject(p);
  res.status(201).json(annotation);
});

// 修改批注内容
app.patch('/api/projects/:id/annotations/:aid', (req, res) => {
  const p = storage.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  const a = p.annotations.find((x) => x.id === req.params.aid);
  if (!a) return res.status(404).json({ error: '批注不存在' });
  const b = req.body || {};
  if (b.note !== undefined) {
    if (typeof b.note !== 'string') return res.status(400).json({ error: '批注内容必须是字符串' });
    a.note = b.note;
  }
  if (b.author !== undefined) a.author = String(b.author).slice(0, 100);
  touch(p);
  storage.putProject(p);
  res.json(a);
});

// 删除批注
app.delete('/api/projects/:id/annotations/:aid', (req, res) => {
  const p = storage.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  const before = p.annotations.length;
  p.annotations = p.annotations.filter((x) => x.id !== req.params.aid);
  if (p.annotations.length === before) return res.status(404).json({ error: '批注不存在' });
  touch(p);
  storage.putProject(p);
  res.json({ ok: true });
});

// 执行迁移：依据旧稿批注在新稿重新定位
app.post('/api/projects/:id/migrate', (req, res) => {
  const p = storage.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  if (!p.newText) return res.status(400).json({ error: '请先粘贴新版文稿' });
  const force = !!(req.body && req.body.force);
  p.annotations = migrateAll(p.annotations, p.oldText, p.newText, { force });
  touch(p);
  storage.putProject(p);
  res.json(p);
});

// 人工选定某条批注在新稿中的位置
app.post('/api/projects/:id/annotations/:aid/manual-locate', (req, res) => {
  const p = storage.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  const a = p.annotations.find((x) => x.id === req.params.aid);
  if (!a) return res.status(404).json({ error: '批注不存在' });
  const b = req.body || {};
  const start = Number(b.start);
  const end = Number(b.end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > p.newText.length) {
    return res.status(400).json({ error: '人工选区坐标无效' });
  }
  a.result = {
    status: 'manual',
    start,
    end,
    candidates: [],
    matchedAt: now(),
  };
  touch(p);
  storage.putProject(p);
  res.json(a);
});

// 标记待处理批注（保持未解决，记录校对员已核对）
app.post('/api/projects/:id/annotations/:aid/mark-pending', (req, res) => {
  const p = storage.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  const a = p.annotations.find((x) => x.id === req.params.aid);
  if (!a) return res.status(404).json({ error: '批注不存在' });
  if (!a.result || a.result.status !== 'pending') return res.status(400).json({ error: '仅待处理批注可标记' });
  a.result.reviewed = true;
  touch(p);
  storage.putProject(p);
  res.json(a);
});

// 兜底 404
app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

app.listen(PORT, () => {
  console.log(`文稿批注迁移工具已启动: http://localhost:${PORT}`);
  console.log(`数据目录: ${storage.DATA_DIR}`);
});
