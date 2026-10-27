# Bookmark Sync — Chrome ↔ ego lite

本机双向书签同步工具。Chrome 与 ego lite 各安装同一个 MV3 扩展，通过只监听 `127.0.0.1` 的中继交换书签。

同步语义是 **双向镜像 + 墓碑删除**：

- 两端最终保持完全一致；任一端新增、删除、改名、移动都会传播
- 初始配对合并双方现有书签，作为镜像基线
- 删除会传播，且不会因另一端仍存在而复活
- 同一书签两端都改过时，按**到达顺序后到者胜**：
  - 先删后改 → 修改到达后复活
  - 先改后删 → 删除照常生效
  - 两种情况都会记录 `delete_vs_edit` 冲突，便于查看
- 文件夹层级、改名、移动、排序都会跟随
- 不依赖云服务、账号或 Chrome 自带同步

## 架构

```text
Chrome 扩展 ─┐
             ├── ws://127.0.0.1:8787 ── 中继（JSON 状态 + 墓碑 + 序号）
ego 扩展   ─┘

core/        纯 TypeScript：身份、差异、合并、协议（无浏览器 API）
extension/   MV3 扩展，Chrome 与 ego 共用同一份 dist
relay/       本机中继服务
tests/       集成与 Playwright E2E
```

详细设计在 [`specs/001-bookmark-sync/`](specs/001-bookmark-sync/)：规格、计划、数据模型、协议契约、快速验收。

## 前置条件

- Windows 10/11
- Node.js ≥ 22.14
- Chrome 与 ego lite（本机验证版本：Chrome 155、ego lite 0.6.0.16）
- ego lite 需要能开启开发者模式并加载已解压扩展（2026-10-27 已实测通过）

## 快速开始

```powershell
# 1. 安装依赖
npm install

# 2. 构建扩展与中继
npm run build

# 3. 启动中继（首次启动会生成令牌）
npm run relay
```

启动后记录：

- 中继地址：`ws://127.0.0.1:8787/ws`
- 令牌：控制台打印，或 `relay/data/token.txt`

### 在 Chrome 中安装

1. 打开 `chrome://extensions`，开启开发者模式。
2. “加载已解压的扩展程序” → 选择 `extension/dist`。
3. 打开扩展设置，填写：
   - 中继地址：`ws://127.0.0.1:8787/ws`
   - 令牌：粘贴 `relay/data/token.txt`
   - 浏览器：Chrome
   - Profile 名称：例如 `default`
4. 保存后回到弹窗，等待首次配对预览。

### 在 ego lite 中安装

1. 切换到准备参与同步的**那一个** Profile。
2. 进入 `chrome://extensions`（或 ego 的扩展管理页），开启开发者模式。
3. 加载 `extension/dist`。
4. 设置中填写相同的中继地址与令牌；浏览器选 `ego`，Profile 名称填当前 Profile（例如 `Profile 2`）。
5. 只在这个 Profile 里配置令牌；其他 Profile 不参与同步。

### 首次配对

1. 两端打开扩展弹窗，等待预览出现。
2. 预览会显示新增 / 更新 / 删除 / 冲突数量；中继会在提交前写备份。
3. 点击“确认合并”完成配对。
4. 之后两端的新增、删除、改名、移动会自动同步。

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm run build` | 构建扩展与中继 |
| `npm run relay` | 启动本机中继 |
| `npm run typecheck` | 三个包的 TypeScript 检查 |
| `npm test` | 单元、契约、不变量、规模测试 |
| `npm run test:e2e` | Playwright 端到端（会自动先构建；会打开浏览器窗口） |
| `npm run smoke` | 中继健康检查 |
| `npm run smoke:ws` | 真实 WebSocket 握手/拉取冒烟 |

首次运行 E2E 需要 Playwright Chromium：

```powershell
# 网络受限时可使用国内镜像
$env:PLAYWRIGHT_DOWNLOAD_HOST="https://cdn.npmmirror.com/binaries/playwright"
npx playwright install chromium
```

## 开机自启

已配置为当前用户登录时自动启动中继（隐藏窗口）：

- 启动脚本：`scripts/start-relay.ps1`
- 注册位置：`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 的 `BookmarkSyncRelay`
- 日志：`relay/data/relay.log`、`relay/data/relay.err.log`
- 脚本会先检查 `/health`，已在运行则不重复启动

手动前台启动（能看到令牌）：

```powershell
npm run relay
```

> 如果自启中继已经在运行，`npm run relay` 会因端口占用失败；先停掉自启实例，或直接用 `scripts/start-relay.ps1`。

移除自启：

```powershell
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "BookmarkSyncRelay"
```

如果移动了项目目录，需要重新注册自启命令（`start-relay.ps1` 会按脚本位置定位项目根目录，但注册表里的脚本路径要同步更新）。

## 数据与安全

- 中继只监听 `127.0.0.1`，不对外网开放。
- 令牌用于本机鉴权；日志不记录书签标题、URL 或令牌明文（启动时打印一次令牌除外）。
- 状态文件：`relay/data/state.json`；备份：`relay/data/backup-*.json`（保留最近 5 份）。
- 轮换令牌：删除 `relay/data/token.txt`，重启中继，然后在两端设置中更新令牌。
- 扩展弹窗提供“导出书签”，可在配对前保存一份 JSON 快照。

## 已知限制（v1）

- 仅同一台电脑；不做跨设备/云同步。
- ego 只支持一个 Profile 参与同步。
- 只同步“书签栏”和“其他书签”，不同步移动端专用的 `synced` 根。
- 规模按 ≤10,000 条书签设计。
- 插入到同级最前面时可能产生额外的 position 变更（数据正确，但有额外写入）。
- E2E 使用 Chrome for Testing；真实 ego 的 V1–V8 手工验收见 [`validation.md`](specs/001-bookmark-sync/validation.md)。

## 故障排查

| 现象 | 排查 |
|---|---|
| 弹窗显示未连接 | 中继是否启动；端口是否为 8787；令牌是否一致；`/health` 是否可达 |
| 无法完成配对 | 设置里是否填了令牌；中继是否在线；点“重置同步状态”后重试 |
| 删除后书签又回来 | 说明另一端在删除之后又编辑了它；双向镜像按后到者胜，会复活并记录冲突 |
| ego 中看不到扩展 | 确认加载到了正确的 Profile，且开发者模式已开启 |
| E2E 启动失败 | 是否已安装 Playwright Chromium；是否有桌面会话运行有头浏览器 |

## 文档

- 规格：`specs/001-bookmark-sync/spec.md`
- 计划：`specs/001-bookmark-sync/plan.md`
- 数据模型：`specs/001-bookmark-sync/data-model.md`
- 协议契约：`specs/001-bookmark-sync/contracts/relay-protocol.md`
- 验收指南：`specs/001-bookmark-sync/quickstart.md`
- 验收记录：`specs/001-bookmark-sync/validation.md`
- 任务清单：`specs/001-bookmark-sync/tasks.md`
