# 文稿批注迁移工具

供校对人员使用的单机网页工具：在旧版文稿上框选文字写批注，粘贴新版文稿后，系统根据**选中文本 + 前后文**在新稿中自动重新定位批注；无法可靠定位时一律标为「待处理」交给人工，**绝不静默挂到错误段落**。

技术栈：Node.js + Express + 原生前端（无构建步骤），数据以 JSON 文件保存在本机 `data/` 目录。

## 快速开始

### 方式一：Docker（推荐，一条命令）

```bash
docker compose up --build
```

### 方式二：本机 Node.js（≥ 18）

```bash
npm install && npm start
```

### 访问地址

启动后在浏览器打开：**http://localhost:3000**

- 默认端口：`3000`。本机方式可用 `PORT=8080 npm start` 修改；Docker 方式修改 `docker-compose.yml` 中的 `ports` 映射（如 `"8080:3000"`）。
- 数据目录：`./data/documents/*.json`（每份文稿一个文件，Compose 已挂载到容器 `/app/data`，删除容器不丢数据）。

## 使用流程

1. **新建文稿**，在 ① 中粘贴旧版文稿并保存；
2. 在旧稿阅读区**框选文字**，弹出输入框写下批注（可反复添加多条）；
3. 在 ② 中粘贴新版文稿，点击「保存新稿并迁移批注」；
4. 在 ③ 中并排查看：左侧为新稿（高亮定位结果），右侧为每条批注的状态：
   - 🟢 **已定位**：唯一出现，或重复出现但前后文可明确区分；
   - 🟡 **待处理**：原文已删除/改写（附相似片段候选），或多处出现且前后文并列（附全部候选位置）——点击候选即可采用；
   - 🔵 **人工指定**：点击「手动定位」后在左侧新稿中框选文字，即保存为该批注的位置（任何批注都可用此方式修正）。
5. 所有操作即时保存，无需额外动作；可随时修改新稿后「重新迁移」。

## 定位规则（核心保证）

| 情况 | 结果 |
|---|---|
| 选中文本在新稿出现 1 次 | 自动定位 |
| 出现多次，比较前后各 80 字符上下文，最高分领先次高分 ≥ 0.3（满分 2） | 自动定位到最高分 |
| 出现多次但上下文得分并列 / 无上下文依据 | **待处理**，列出全部候选位置 |
| 出现 0 次（删除或改写） | **待处理**，附二元组相似度 ≥ 0.45 的相似片段候选 |

匹配对换行、多余空格等空白差异不敏感（归一化后比对，位置映射回原文）。

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/documents` | 文稿列表 |
| POST | `/api/documents` | 新建文稿 `{title}` |
| GET / DELETE | `/api/documents/:id` | 详情 / 删除 |
| PUT | `/api/documents/:id/old` | 保存旧稿 `{oldText}`（自动重算批注上下文） |
| POST | `/api/documents/:id/annotations` | 添加批注 `{start, end, comment}` |
| DELETE | `/api/documents/:id/annotations/:aid` | 删除批注 |
| PUT | `/api/documents/:id/new` | 保存新稿 `{newText}` |
| POST | `/api/documents/:id/migrate` | 执行迁移 |
| PUT | `/api/documents/:id/annotations/:aid/position` | 人工指定位置 `{start, end}` |

## 测试

```bash
npm test   # 定位逻辑的单元测试（node:test）
```

## 项目结构

```
server.js          Express 服务与 API
lib/match.js       批注重定位核心算法
public/            原生前端（index.html / app.js / style.css）
test/match.test.js 定位算法单元测试
data/              文稿与批注数据（运行时生成）
Dockerfile / docker-compose.yml
```
