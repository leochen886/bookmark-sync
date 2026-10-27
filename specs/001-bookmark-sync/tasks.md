---

description: "Task list for 浏览器书签双向同步插件"
---

# Tasks: 浏览器书签双向同步插件

**Input**: Design documents from `/specs/001-bookmark-sync/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/relay-protocol.md](./contracts/relay-protocol.md), [quickstart.md](./quickstart.md)

**Tests**: 规格未要求 TDD，但计划（plan.md § Technical Context）明确使用 Vitest 与 Playwright 验证 SC-001~SC-007，因此各用户故事包含测试任务，并安排在对应实现之前。

**Organization**: 按用户故事分阶段，便于独立实现与验收。US1 建立整条同步管线，US2/US3 扩展同一组核心文件，按优先级顺序执行。

> **2026-10-27 需求更新**：同步语义由并集合并改为**双向镜像**（两端最终一致）；T026/T028 的冲突描述已同步调整为"按到达顺序后到者胜"。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件、无未完成依赖）
- **[Story]**: 所属用户故事（US1、US2、US3、US4）
- 每个任务都包含精确文件路径

## Path Conventions

仓库根目录 `E:\BaiduSyncdisk\Codetools\书签同步插件`，三包工作区：

```text
core/       合并引擎与协议（纯 TypeScript）
extension/  MV3 扩展（Chrome 与 ego 共用）
relay/      本机中继服务
tests/      跨包集成与 E2E
scripts/    构建与冒烟脚本
```

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 项目初始化，并先通过 ego 扩展加载这道硬门槛。

- [x] T001 **硬门槛**：在 ego lite（本机 0.6.0.16）中打开扩展管理页，确认“开发者模式”可开启，并用最小 MV3 扩展执行“加载已解压的扩展程序”；记录版本、入口地址、结果与截图路径到 `specs/001-bookmark-sync/research.md` §R1。失败则停止后续任务，转为文件桥接方案。**结果（2026-10-27）：PASS**，`verification/ego-load-check` 加载成功，bookmarks/storage/alarms 均可用，读取 170 个节点。
- [x] T002 创建 npm workspaces 根配置：`package.json`（workspaces: core, extension, relay）、`tsconfig.base.json`（strict、target ES2022）、`.gitignore`（`node_modules/`、`dist/`、`relay/data/`）。
- [x] T003 [P] 初始化 core 包：`core/package.json`、`core/tsconfig.json`、`core/src/index.ts`，添加 Vitest 配置。
- [x] T004 [P] 初始化 extension 包：`extension/package.json`、`extension/tsconfig.json`、`extension/manifest.json`（Manifest V3，permissions: `bookmarks`, `storage`, `alarms`；host_permissions: `http://127.0.0.1/*`）。
- [x] T005 [P] 初始化 relay 包：`relay/package.json`、`relay/tsconfig.json`、`relay/src/index.ts`，依赖 `ws` 与 `zod`。
- [x] T006 [P] 编写构建与冒烟脚本：`scripts/build.mjs`（esbuild 打包扩展、编译 core/relay）、`scripts/smoke.mjs`（启动临时中继跑一次握手），并在根 `package.json` 暴露 `build`、`dev`、`relay`、`test`、`test:e2e`、`smoke`。

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 所有用户故事共同依赖的模型、协议、存储、连接与浏览器适配层。

**⚠️ CRITICAL**: 本阶段完成前不得开始任何用户故事。

- [x] T007 [P] 实现规范实体类型于 `core/src/model.ts`：`SyncNode`、`Tombstone`、`Endpoint`、`EndpointSnapshot`、`Change`、`CanonicalState`，字段与 `data-model.md` §2/§4/§5/§6/§7 一致。强制约束：`kind=bookmark` 时 `url` 非空；`kind=folder` 时 `url === null`；`title` 上限 4096 字符；`url` 上限 65536 字符。
- [x] T008 [P] 实现协议类型与 zod 校验于 `core/src/protocol.ts`：`hello`、`welcome`、`push`、`push-result`、`commit`、`pull`、`ops`、`ack`、`resync`、`snapshot`、`ping`、`pong`、`error`，字段与错误码严格对齐 `contracts/relay-protocol.md` §2–§8。
- [x] T009 [P] 实现中继状态存储于 `relay/src/state-store.ts`：`CanonicalState` 加载/保存、`schemaVersion: 1`、临时文件 + 原子重命名、保留最近 5 份 `backup-<ts>.json`、损坏时回退最近备份（research.md R6）。
- [x] T010 [P] 实现扩展书签适配器于 `extension/src/background/bookmarks-adapter.ts`：用 `chrome.bookmarks.getTree` 生成扁平快照（`localId`、`parentLocalId`、`rootKey`、`kind`、`title`、`url`、`position`、`dateAdded`），封装 create/update/move/remove，并订阅 `onCreated/onChanged/onMoved/onRemoved`。只读 `bookmark_bar` 与 `other` 两个根，忽略 `synced`。
- [x] T011 实现中继 WebSocket 服务于 `relay/src/server.ts`：仅绑定 `127.0.0.1:8787`，`hello` 鉴权（SHA-256 令牌比对）、`GET /health`、`ping/pong`、关闭码 `4401`/`4408`/`4409`；首次启动生成令牌并写入 `relay/data/token.txt`（不记录明文日志）。
- [x] T012 实现端点会话与序号分配于 `relay/src/session.ts`：端点注册、单端点单连接（新连接顶掉旧连接）、`seq` 单调递增、`lastSeq` 与 `ack` 维护。
- [x] T013 实现扩展同步客户端骨架于 `extension/src/background/sync-client.ts`：连接 `ws://127.0.0.1:8787/ws`、发送 `hello`（含 `endpointId`、`installId`、`browser`、`profileLabel`）、1s→30s 指数退避重连、25 秒 `ping`、45 秒无消息判定断线。
- [x] T014 [P] 实现身份工具于 `core/src/identity.ts`：`normalize`（Unicode NFC、去首尾空白、URL 保守规范化）、`contentKey = sha256(parentPath + "\u0000" + title + "\u0000" + normalizedUrl)`、`localId ↔ syncId` 映射的序列化/反序列化（data-model.md §3）。
- [x] T015 [P] 实现回环抑制状态机于 `extension/src/background/loop-guard.ts`：记录待应用变更的“期望状态”（本地 ID → 期望父级/标题/URL），提供 `expect()`、`consumeEvent()`、1.5 秒窗口兜底、`commitBaseline()`（research.md R4）。
- [x] T016 [P] 实现 UI 骨架于 `extension/src/ui/popup.ts` 与 `extension/src/ui/options.ts`：中继地址、令牌、端点名称、连接测试按钮；配置读写 `chrome.storage.local`。
- [x] T017 注册 Service Worker 与周期任务于 `extension/src/background/service-worker.ts`：监听书签事件触发同步、`chrome.alarms` 每 1 分钟补偿唤醒、启动时恢复 `chrome.storage.local` 中的基线（research.md R8）。

**Checkpoint**: 基础层就绪——连接、鉴权、存储、书签读写与回环抑制骨架可用。

---

## Phase 3: User Story 1 - 两端新增的书签合并后都保留 (Priority: P1) 🎯 MVP

**Goal**: 任一端新增的书签在同步后存在于两端，且不产生重复。

**Independent Test**: 在 Chrome 与 ego 各新增一个不同书签，同步后两端都恰好包含两个书签。

### Tests for User Story 1

- [x] T018 [P] [US1] 单元测试并集语义于 `core/tests/merge.test.ts`：断言新增节点全部保留（INV-1）、`syncId` 唯一（INV-2）、同内容同父级合并为一条（FR-008）；先运行并确认失败。
- [x] T019 [P] [US1] 协议契约测试于 `relay/tests/protocol.test.ts`：覆盖 `hello → push → push-result → pull → ops → ack` 的新增流程、`bindings` 回传、`snapshotHash` 幂等；先运行并确认失败。

### Implementation for User Story 1

- [x] T020 [US1] 实现快照差异于 `core/src/diff.ts`：将端点推送树与 `EndpointSnapshot` 比较，产出 `add` 与 `update` 操作；输出按父级 `position` 稳定排序。
- [x] T021 [US1] 实现新增合并于 `core/src/merge.ts`：无 `syncId` 节点按 `contentKey` 匹配或分配新 `syncId`；同父级同内容键合并为一条；`modifiedAt` 并列时按 `rev`、再按 `origin` 字典序裁决（data-model.md §9）。
- [x] T022 [US1] 实现中继 `push`/`pull`/`commit` 处理于 `relay/src/session.ts`：`dryRun` 预演缓存（TTL 5 分钟、按 `requestId`）、`snapshotHash` 校验、事务式应用并分配 `seq`、返回 `bindings` 与 `counts`（contracts §4）。
- [x] T023 [US1] 实现扩展推送与远端新增应用于 `extension/src/background/sync-client.ts`：500ms 防抖推送整树、按 `seq` 顺序应用 `ops`、调用 `bookmarks-adapter` 创建节点、应用后推进基线与映射、发送 `ack`。
- [x] T024 [US1] 实现首次配对预演/确认与备份（FR-011）于 `extension/src/ui/popup.ts` 与 `relay/src/state-store.ts`：展示新增/合并/冲突计数，用户确认后 `commit`；提交前写 `relay/data/backup-<ts>.json`，扩展侧提供“导出当前书签”。
- [x] T025 [US1] 端到端测试于 `tests/e2e/union-add.spec.ts`：Playwright 持久化 Chromium 加载 `extension/dist`，模拟两端各新增一个书签，断言两端集合一致且无重复。

**Checkpoint**: US1 可独立验收——这是可交付的 MVP。

---

## Phase 4: User Story 2 - 删除会传播且不会复活 (Priority: P2)

**Goal**: 一端删除后另一端同步删除，后续同步不复活。

**Independent Test**: 两端存在同一书签，在 Chrome 删除，ego 中消失；连续 10 次同步后仍不出现。

### Tests for User Story 2

- [x] T026 [P] [US2] 单元测试删除语义于 `core/tests/delete.test.ts`：墓碑生效、已删除节点不因“对端仍存在”而复活（INV-3）、删除与修改冲突按镜像后到者胜（先改后删则删除、先删后改则复活）并标记 `delete_vs_edit`（FR-006）；先运行并确认失败。

### Implementation for User Story 2

- [x] T027 [US2] 扩展差异计算于 `core/src/diff.ts`：端点快照中消失的节点产出 `delete` 操作，附带删除时间与来源。
- [x] T028 [US2] 实现墓碑合并于 `core/src/merge.ts`：删除按到达顺序生效并记录 `delete_vs_edit`（`resolution: delete_wins`）；对已删除节点收到内容不同的 `update/move` 时产出 `undelete`（`resolution: keep_modified`）。
- [x] T029 [US2] 实现墓碑持久化与清理于 `relay/src/state-store.ts` 与 `relay/src/session.ts`：墓碑随状态落盘；仅当所有端点 `lastSeq >= tombstone.seq` 且超过 30 天时清理（data-model.md §4）。
- [x] T030 [US2] 实现远端删除应用与回环抑制于 `extension/src/background/sync-client.ts` 与 `loop-guard.ts`：调用 `chrome.bookmarks.removeTree/remove`，将受影响子树加入期望状态，忽略自身触发事件，完成后推进基线。
- [x] T031 [US2] 端到端测试于 `tests/e2e/delete.spec.ts`：删除传播、连续 10 次同步不复活、删除文件夹时子项一并消失。

**Checkpoint**: US1 + US2 同时可用，删除不再造成幽灵书签。

---

## Phase 5: User Story 3 - 文件夹结构、改名和移动被保留 (Priority: P3)

**Goal**: 文件夹层级、名称、顺序以及书签归属在两端一致；改名/移动不产生副本。

**Independent Test**: 构造三层文件夹与书签，同步后逐层比对路径、名称与顺序；再改名、移动，验证跟随且无副本。

### Tests for User Story 3

- [x] T032 [P] [US3] 单元测试结构语义于 `core/tests/structure.test.ts`：多层文件夹、文件夹改名、书签移动、循环移动被拒绝、位置规整为连续值；先运行并确认失败。

### Implementation for User Story 3

- [x] T033 [US3] 实现结构合并于 `core/src/merge.ts`：处理 `move` 与文件夹 `update`；落实校验规则——`parentSyncId` 不存在时先在同批次查找、否则挂到 `other` 并记警告；出现环时拒绝该 `move` 并记冲突；`position` 为负或非整数时置为末尾并记警告；根节点不可删除；同一 `syncId` 在一批中出现两次时拒绝整批（data-model.md §11）。合并后同一父级位置重排为 `0..n-1`。
- [x] T034 [US3] 扩展适配器支持文件夹操作于 `extension/src/background/bookmarks-adapter.ts`：`chrome.bookmarks.create`（文件夹）、`update`（改名/改 URL）、`move`（含跨父级移动与索引）。
- [x] T035 [US3] 扩展差异计算于 `core/src/diff.ts`：比较 `parentLocalId` 与 `position` 产出 `move`，比较标题产出 `update`；移动不产生“删除 + 新增”。
- [x] T036 [US3] 端到端测试于 `tests/e2e/structure.spec.ts`：三层文件夹同步、改名跟随、跨文件夹移动、无副本。

**Checkpoint**: US1–US3 完成，书签的组织结构可用。

---

## Phase 6: User Story 4 - 同步状态可见、可控、可恢复 (Priority: P4)

**Goal**: 状态可见、可暂停/恢复/手动同步，断线期间变更可补偿，冲突可见。

**Independent Test**: 停止中继，两端各做修改，恢复后全部合并且无丢失/重复；界面状态正确切换。

### Tests for User Story 4

- [x] T037 [P] [US4] 单元测试离线与幂等于 `relay/tests/session.test.ts`：断线重连补发、重复 `push` 不产生新 `seq`（INV-4）、`ack` 丢失后的重放；先运行并确认失败。

### Implementation for User Story 4

- [x] T038 [US4] 实现离线补偿于 `extension/src/background/sync-client.ts` 与 `service-worker.ts`：断线期间保留本地树与 `baseSeq`，重连后重新 `push`；`chrome.alarms` 每分钟兜底；收到 `SEQ_GAP` 时先 `resync` 再 `push`（contracts §8）。
- [x] T039 [US4] 实现状态界面于 `extension/src/ui/popup.ts`：连接状态、最近同步时间、待同步数量、冲突数、错误信息（FR-012）。
- [x] T040 [US4] 实现同步控制于 `extension/src/background/service-worker.ts` 与 `extension/src/ui/popup.ts`：暂停/恢复、立即同步、重置同步状态；暂停时不发起写入（FR-013）。
- [x] T041 [US4] 实现 Profile 选择与端点标识于 `extension/src/ui/options.ts` 与 `relay/src/session.ts`：端点 ID 采用 `installId:browser:profileLabel`；只允许一个 ego Profile 配置令牌，未配置 Profile 不参与同步（FR-010）。
- [x] T042 [US4] 实现冲突记录展示于 `relay/src/session.ts` 与 `extension/src/ui/popup.ts`：保存最近冲突条目（`syncId`、类型、裁决、时间），界面可查看，不包含书签 URL 明文日志。
- [x] T043 [US4] 端到端测试于 `tests/e2e/offline.spec.ts`：停止中继 → 两端各新增 → 重启中继 → 5 分钟内追平；暂停/恢复；冲突场景可见。

**Checkpoint**: 全部用户故事可独立且协同工作。

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: 不变量验证、规模与安全收尾。

- [x] T044 [P] 随机树不变量测试于 `core/tests/invariants.test.ts`：随机生成书签树与操作序列，至少 1,000 组，断言 INV-1 ~ INV-8（收敛、幂等、不丢数据、确定性）。
- [x] T045 [P] 规模测试于 `tests/integration/scale.test.ts`：1,000 条书签、5 层文件夹首次合并，断言 60 秒内完成且结构一致率 100%（SC-004）。
- [x] T046 安全加固于 `relay/src/server.ts`：时间恒定令牌比较、仅回环来源、日志脱敏（不输出 title/url/token）、`/health` 仅返回计数（contracts §10）。
- [x] T047 [P] 编写 `README.md`：构建、启动中继、在 Chrome/ego 加载扩展、常见问题，链接 `quickstart.md`。
- [ ] T048 按 `quickstart.md` 手工执行 V1–V8，将结果、耗时与截图路径记录到 `specs/001-bookmark-sync/validation.md`；对失败项回填任务并修复。**自动化等价项已完成并记录（V1–V5、V7）；真实 ego 的 V6 长跑与 V8 多 Profile 待用户执行，见 `validation.md` §4–5。**
- [x] T049 运行完整测试套件（`npm test`、`npm run test:e2e`、`npm run smoke`），清理临时日志与死代码，确认无跳过的关键用例。

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 无依赖；T001 是**停止/继续门槛**，失败则整体改用文件桥接方案。
- **Foundational (Phase 2)**: 依赖 Setup；**阻塞所有用户故事**。
- **US1 (Phase 3)**: 依赖 Phase 2；建立快照差异、合并与推送/拉取管线。
- **US2–US4 (Phase 4–6)**: 依赖 US1 建立的管线，并与 US1/US2 修改同一批文件（`core/src/merge.ts`、`core/src/diff.ts`、`extension/src/background/sync-client.ts`），因此**按 P1 → P2 → P3 → P4 顺序执行**。
- **Polish (Phase 7)**: 依赖所有目标故事完成。

### Within Each User Story

- 测试任务先写并确认失败，再进入实现。
- 模型/身份 → 差异 → 合并 → 中继会话 → 扩展应用 → E2E。
- 同一文件被多个故事修改时不得并行。

### Parallel Opportunities

- Phase 1：T003、T004、T005、T006 可并行（不同包/脚本）。
- Phase 2：T007、T008、T009、T010 可并行；T014、T015、T016 可并行；T011–T013、T017 需按依赖顺序。
- 各故事内的测试任务（T018/T019、T026、T032、T037）可并行编写。
- Phase 7：T044、T045、T047 可并行。

### Parallel Example: Foundational

```text
Task: "实现规范实体类型于 core/src/model.ts"
Task: "实现协议类型与 zod 校验于 core/src/protocol.ts"
Task: "实现中继状态存储于 relay/src/state-store.ts"
Task: "实现扩展书签适配器于 extension/src/background/bookmarks-adapter.ts"
```

### Parallel Example: User Story 1 Tests

```text
Task: "单元测试并集语义于 core/tests/merge.test.ts"
Task: "协议契约测试于 relay/tests/protocol.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. 完成 Phase 1（含 T001 硬门槛）。
2. 完成 Phase 2（阻塞项）。
3. 完成 Phase 3（US1）。
4. **停止并验收**：两端各加一个书签，确认都保留且无重复。
5. 若通过，即可作为一个可演示的最小版本。

### Incremental Delivery

1. Setup + Foundational → 基础层就绪。
2. US1 → 验收并集新增（MVP）。
3. US2 → 验收删除传播与不复活。
4. US3 → 验收文件夹结构、改名、移动。
5. US4 → 验收状态界面、离线补偿、暂停/恢复。
6. Phase 7 → 不变量、规模、安全与手工验收收尾。

### Notes

- [P] 任务表示不同文件、无未完成依赖。
- US2–US4 共用核心文件，按优先级串行，避免同文件冲突。
- 每个 Checkpoint 都应实际运行 quickstart 对应场景，而不是只跑单元测试。
- T001 未通过前不要投入 US1 之后的实现工作量。
