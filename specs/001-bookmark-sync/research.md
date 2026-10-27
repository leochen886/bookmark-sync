# Phase 0 Research: 浏览器书签双向同步插件

**Feature**: `001-bookmark-sync` | **Date**: 2026-10-27

本阶段的目标是消除 `plan.md` 技术上下文中的未知项。所有结论都基于本机实测与 Chromium 扩展平台行为，未引入需要联网确认的假设。

---

## R1. ego lite 能否加载未上架的 MV3 扩展

**Decision**: 以"可以加载"为计划前提，并已在本机完成验证（见下方结果）。合并核心与中继不依赖这个结论；若未来版本失效，改用"本机中继 + 文件桥接"路径，不改合并语义。

**Verification result (2026-10-27, ego lite 0.6.0.16)**: PASS。`chrome://extensions` 可访问，开发者模式可开启，`verification/ego-load-check` 成功加载为未打包扩展；弹窗显示 `bookmarks`、`storage`、`alarms` API 均可用，`chrome.bookmarks.getTree()` 读到 170 个节点（根节点 ID `0`）。结论：本机 ego 允许加载未上架 MV3 扩展并授予书签权限。

**Rationale**:
- 本机 ego lite 为 Chromium 内核（安装目录含 `chrome.dll`，版本 0.6.0.16），Profile 1–4 各有 12–15 个已安装扩展。
- `Profile 2\Secure Preferences` 中存在 `from_webstore: false` 且带本地绝对路径的扩展记录，说明浏览器具备"按路径注册扩展"的机制。
- 但组件扩展的路径加载与用户"开发者模式 → 加载已解压扩展"不是同一条代码路径，不能仅凭此判定成功，必须实测。

**Verification (实现第 0 步)**:
1. 打开 ego lite 的扩展管理页（通常为 `chrome://extensions` 或 ego 自有入口）。
2. 确认存在"开发者模式"开关；开启后加载 `extension/dist`。
3. 若入口被移除/禁用，记录为硬阻塞并切换到备选方案。

**Alternatives considered**:
- 纯文件同步：浏览器运行时把书签保存在内存并会覆盖外部写入，只能在关闭浏览器时安全写回；无法满足 10 秒级实时同步。
- 原生消息（Native Messaging）：需要安装宿主程序并写注册表，Windows 部署成本高，且 ego 对宿主白名单未知。

---

## R2. 跨浏览器书签身份：`chrome.bookmarks` 不暴露 GUID

**Decision**: 由扩展生成 `syncId`（UUID），并在 `chrome.storage.local` 维护 `localId → syncId` 映射。首次配对用内容键 `hash(父文件夹路径, 标题, 规范化 URL)` 匹配；之后改名、移动、改 URL 因 `localId` 不变而保持同一身份。

**Rationale**:
- `chrome.bookmarks.BookmarkTreeNode` 只提供 `id`、`parentId`、`title`、`url`、`dateAdded` 等；`id` 只在当前 Profile 内有效，且不同浏览器之间互不相关。
- Chromium 的 `Bookmarks` 文件内部有 `guid` 字段，但扩展 API 不暴露，扩展也无法直接读文件。
- 内容键只能用于"初次相遇"的匹配；一旦建立映射，就必须以本地 ID 为锚点，否则改名/移动会产生"删除 + 新增"。

**Alternatives considered**:
- 以 URL 作为身份：用户编辑 URL 时会被误判为删除旧书签、新增新书签，违反 FR-004。
- 以"标题 + URL"作为身份：改名会丢失身份，同样被误判。
- 读取 `Bookmarks` 文件的 `guid`：需要文件访问权限与浏览器关闭，且 ego 路径特殊，不可行。

---

## R3. 同步模型：快照差异而非增量事件流

**Decision**: 扩展在书签变更后做 500ms 防抖，推送"当前整棵树 + 上次同步基线 + `baseSeq`"；中继把该树与此前记录的该端点快照做差异，得到新增/修改/移动/删除操作，合并进规范状态后递增 `seq`。扩展按 `seq` 拉取变更并应用。

**Rationale**:
- MV3 Service Worker 会在空闲约 30 秒后被回收，WebSocket 连接随时断开；逐事件流一旦丢事件就无法自愈。
- 整树快照幂等、可重放，断线重连后只需再推一次即可追平。
- 本规格上限 10,000 条书签，整树 JSON 约数百 KB，回环传输开销可接受。

**Alternatives considered**:
- 增量事件流 + 持久队列：需要额外的队列持久化与去重，复杂度更高，收益有限。
- 文件监听：受浏览器运行时覆盖限制，且拿不到变更来源。

---

## R4. 同步回环抑制

**Decision**: 应用远端变更前，记录"期望状态"（受影响的本地 ID 集合及期望的父节点/标题/URL）。`chrome.bookmarks` 事件到达时，若与期望状态匹配则消费并忽略；应用完成后立即把本地基线推进到新树。另设 1.5 秒时间窗作为兜底，窗内由自身写入产生的、未被期望状态覆盖的事件也忽略。

**Rationale**:
- `chrome.bookmarks.onCreated/onChanged/onRemoved/onMoved` 不区分来源，自身写入同样触发；仅靠时间窗在慢机器上会漏，仅靠期望状态在"用户同时操作"时会误吞。
- 基线推进是关键：下一次差异计算以"应用后的树"为基线，天然不会把远端变更再推回去。

**Alternatives considered**:
- 只靠时间窗：慢设备上可能漏判，导致重复或抖动。
- 只靠标志位：异步事件与标志位生命周期难以对齐。

---

## R5. 传输层：本机 WebSocket

**Decision**: 中继监听 `127.0.0.1:8787`，提供 `ws://127.0.0.1:8787/ws` 与 `GET /health`。扩展在 `hello` 中携带端点 ID、浏览器类型与每安装生成的令牌；断线采用指数退避重连，最长 30 秒。

**Rationale**:
- 扩展背景页可直接连接 localhost；无需安装原生宿主，部署最简单。
- 双向推送使变更在秒级到达对端，优于轮询。
- 令牌防止本机其他进程随意读取/写入书签数据。

**Alternatives considered**:
- 原生消息：需宿主安装与注册表配置，ego 兼容性未知。
- HTTP 轮询：实现简单但延迟与请求开销更高。
- 云端中转：违反"本机中继、无账号"的规格约束。

---

## R6. 中继持久化

**Decision**: 使用单个 JSON 状态文件（`relay/data/state.json`），写入采用"同目录临时文件 + 原子重命名"，每次成功写入前保留最近 5 份滚动备份。启动时若主文件损坏，回退到最近可用备份。

**Rationale**:
- 数据规模 ≤10,000 条，序列化成本低；避免 `better-sqlite3` 在 Windows 上的原生编译问题。
- 原子重命名可避免进程中断产生的半写文件。
- Node 22 的 `node:sqlite` 仍为实验特性，不宜作为 v1 依赖。

**Alternatives considered**:
- SQLite：事务能力强，但引入原生依赖与迁移管理，当前规模不需要。
- 纯内存：中继重启即丢规范状态与墓碑，会导致删除复活。

---

## R7. 冲突裁决规则

**Decision（2026-10-27 调整为双向镜像）**:
1. 同一书签两端都改过（含一方删除、另一方改名/移动）→ **按中继到达顺序后到者胜**：先删后改则复活（`keep_modified`），先改后删则删除（`delete_wins`）；两种情况都记录 `delete_vs_edit`。
2. 双方都改名或移动 → 后到达的推送覆盖先到达的；时间相同则按端点 ID 字典序固定裁决。
3. 双方新增且内容键相同 → 合并为一条。
4. 同一 URL 在不同文件夹或不同标题 → 视为不同书签，全部保留。

**Rationale**: 用户明确要求两端最终完全一致（双向镜像）。Chrome 的 `bookmarks` API 不暴露 `dateModified`，无法得到真实的本地修改时间，因此用中继的串行到达顺序作为确定性时钟；这保证两端收敛，且冲突可解释、可追溯。

**Alternatives considered**:
- 一律保留修改（原并集策略）：不丢数据，但会出现"删了又回来"，不符合镜像预期。
- 一律删除优先：实现简单，但先删后改的合法修改会被丢掉。
- 依赖本地修改时间戳：需要扩展自己维护变更时间，且无法覆盖浏览器关闭期间的修改；v1 不做。

---

## R8. MV3 Service Worker 生命周期

**Decision**: Service Worker 不持有唯一状态；端点 ID、令牌、映射、基线、快照索引全部写入 `chrome.storage.local`。使用 `chrome.alarms` 每 1 分钟唤醒一次做补偿同步；书签事件与界面操作同样触发即时同步。

**Rationale**: MV3 后台脚本会被回收，任何内存态都可能在两次事件之间消失。`chrome.alarms` 最短周期为 1 分钟，适合作为兜底而非主路径。

**Alternatives considered**:
- 常驻后台页：MV3 不支持。
- 依赖 WebSocket 保活：连接被回收后无法自恢复。

---

## R9. 测试策略

**Decision**:
- `core`：Vitest 单元测试 + 随机树对拍（生成随机书签树与随机操作序列，断言合并满足交换律、幂等性与"不丢数据"不变量）。
- `relay`：内存状态存储 + 临时目录，覆盖序号、确认、断线重放、损坏恢复。
- `extension`：Playwright 使用持久化 Chromium 上下文加载 `extension/dist`，对 `chrome.bookmarks` 做真实读写。
- ego lite：提供逐步手工验收清单（见 `quickstart.md`），因为其自动化驱动能力尚未确认。

**Rationale**: 合并规则是本项目风险最高的部分，必须用与浏览器无关的方式高频验证；浏览器侧只验证适配与回环抑制。

**Alternatives considered**:
- 只做手工端到端：每次回归成本高，边界场景难以覆盖。
- 在 ego 上跑自动化：接入方式未知，暂不作为 v1 目标。

---

## Open Items Carried Into Implementation

| 项 | 处理方式 |
|---|---|
| ego 扩展加载入口与开发者模式 | 实现第 0 步实测；失败则切换到文件桥接方案，`core` 不变 |
| 扩展背景页连接 localhost 的权限与网络策略 | 在 `manifest.json` 声明 `host_permissions`，首次联调验证 |
| 10000 条书签下的快照体积与序列化耗时 | 在性能验收中测量；若超限，改用分片传输（不改变协议语义） |
| 多 Profile 场景的端点标识 | 扩展天然按 Profile 隔离；中继以"浏览器 + Profile 名称 + 安装 ID"标识端点 |
