'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function ensureReady() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ projects: {} }, null, 2), 'utf8');
}

let cache = null;

function load() {
  if (cache) return cache;
  ensureReady();
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw || '{"projects":{}}');
    if (!parsed.projects || typeof parsed.projects !== 'object') parsed.projects = {};
    cache = parsed;
  } catch (e) {
    cache = { projects: {} };
  }
  return cache;
}

let saveTimer = null;
function save() {
  ensureReady();
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(load(), null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

// 同步落盘（接口响应前调用，避免容器停止丢数据）
function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  save();
}

function listProjects() {
  const db = load();
  return Object.values(db.projects)
    .map((p) => ({
      id: p.id,
      title: p.title,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      oldLength: (p.oldText || '').length,
      newLength: (p.newText || '').length,
      annotationCount: (p.annotations || []).length,
      pendingCount: (p.annotations || []).filter((a) => a.result && a.result.status === 'pending').length,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function getProject(id) {
  return load().projects[id] || null;
}

function putProject(project) {
  load().projects[project.id] = project;
  saveNow();
}

function deleteProject(id) {
  delete load().projects[id];
  saveNow();
}

module.exports = {
  DATA_DIR,
  load,
  saveNow,
  listProjects,
  getProject,
  putProject,
  deleteProject,
};
