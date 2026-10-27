# Phase 1 Data Model: 浏览器书签双向同步插件

**Feature**: `001-bookmark-sync` | **Date**: 2026-10-27

本文件定义合并引擎的规范数据模型。所有实体都属于 `core` 包，与浏览器 API 无关；扩展与中继只负责把各自的表示转换为这里的规范形式。

---

## 1. 实体总览

```text
Endpoint 1 ──push snapshot──▶ Relay ──ops──▶ Endpoint 2
     ▲                          │
     └────────── ops ───────────┘

Relay 持有：CanonicalState { nodes[], tombstones[], seq }
每个 Endpoint 持有：localId↔syncId 映射、lastSeq、本地基线树
```

---

## 2. SyncNode（书签 / 文件夹）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `syncId` | string (UUID v4) | 是 | 跨端稳定身份；由中继在首次见到节点时分配，之后永不变 |
| `kind` | `"bookmark" \| "folder"` | 是 | 节点类型 |
| `title` | string | 是 | 书签标题或文件夹名称；允许空字符串 |
| `url` | string \| null | 是 | 书签的网址；文件夹必须为 `null` |
| `parentSyncId` | string \| null | 是 | 所属父文件夹；根节点为 `null` |
| `rootKey` | `"bookmark_bar" \| "other" \| null` | 是 | 仅两个虚拟根节点使用；其他节点为 `null` |
| `position` | integer ≥ 0 | 是 | 在父节点内的排序位置；合并后重新规整为连续值 |
| `createdAt` | integer (epoch ms) | 是 | 首次出现时间 |
| `modifiedAt` | integer (epoch ms) | 是 | 最近一次标题/网址/父级/位置变化时间 |
| `origin` | string | 是 | 最近一次写入的端点 ID |
| `rev` | integer ≥ 1 | 是 | 节点版本号；每次修改递增，用于并列时间戳的确定性裁决 |
| `deleted` | boolean | 是 | 软删除标记；与墓碑一一对应 |
| `deletedAt` | integer \| null | 是 | 删除时间；未删除为 `null` |
| `contentKey` | string (hex) | 是 | 内容键，见 §3；仅用于首次配对匹配 |

**不变量**: `kind = "folder"` 时 `url === null`；`kind = "bookmark"` 时 `url` 非空；`syncId` 全局唯一；文件夹不能成为自己的祖先。

---

## 3. 身份规则（Identity）

`localId` 是 `chrome.bookmarks` 在当前 Profile 内的编号，只在本机有效，**不得**出现在规范状态中。

- **内容键**: `contentKey = sha256(normalize(parentPath) + "\u0000" + normalize(title) + "\u0000" + normalize(url ?? ""))`
  - `parentPath` 为从根到父文件夹的标题路径，以 `/` 连接；根为 `bookmark_bar` 或 `other`。
  - `normalize` 做 Unicode NFC、去除首尾空白；URL 仅做大小写与末尾斜杠的保守规范化，不改写查询参数。
- **首次配对**: 端点推送的节点若没有 `syncId`，中继按 `contentKey` 在规范状态中查找候选。
  - 恰好一个候选 → 绑定该 `syncId` 并回传映射。
  - 多个候选（重复内容）→ 按"路径内出现顺序 + `dateAdded`"与候选的 `position` 做稳定配对，多出的候选创建新节点。
  - 无候选 → 分配新 `syncId`。
- **绑定之后**: 扩展持久化 `localId → syncId`；改名、移动、改 URL 都不改变 `localId`，因此身份稳定（对应 FR-004）。

---

## 4. Tombstone（墓碑）

| 字段 | 类型 | 说明 |
|---|---|---|
| `syncId` | string | 被删除的节点身份 |
| `deletedAt` | integer (epoch ms) | 删除发生时间 |
| `origin` | string | 发起删除的端点 |
| `seq` | integer | 删除被写入规范状态时的全局序号 |
| `reason` | `"user_delete" \| "parent_delete"` | 删除来源 |

**生命周期**:
1. 端点上报"节点消失"且规范状态中该节点 `modifiedAt ≤ 删除请求时间` → 标记 `deleted = true`，写墓碑。
2. 端点上报的修改/移动内容与墓碑前不同（说明修改发生在删除之后）→ 复活节点（`deleted = false`，`rev++`），并在同步记录中标记 `delete_vs_edit`。
3. 当所有已注册端点的 `lastSeq ≥ tombstone.seq`，且超过保留期（默认 30 天）后，墓碑与软删除节点可被清理（GC）。
4. GC 之后的节点即使被旧端点重新上报，也按新节点处理，不再复活。

---

## 5. Endpoint（同步端点）

| 字段 | 类型 | 说明 |
|---|---|---|
| `endpointId` | string | `installId + ":" + browser + ":" + profileLabel` |
| `browser` | `"chrome" \| "ego"` | 浏览器类型 |
| `profileLabel` | string | 用户可读的 Profile 名称；ego 多 Profile 时用于选择 |
| `tokenHash` | string | 端点令牌的哈希；不保存明文 |
| `lastSeq` | integer | 已确认应用的最大序号 |
| `lastSeenAt` | integer | 最近一次心跳时间 |
| `lastSnapshotHash` | string | 最近一次推送树的哈希，用于跳过无变化推送 |
| `status` | `"online" \| "offline" \| "paused"` | 连接状态 |

---

## 6. EndpointSnapshot（中继侧差异基线）

| 字段 | 类型 | 说明 |
|---|---|---|
| `endpointId` | string | 所属端点 |
| `seqAtCapture` | integer | 采集时的规范序号 |
| `capturedAt` | integer | 采集时间 |
| `nodes` | array | `{ localId, parentLocalId, kind, title, url, position, dateAdded, syncId? }` |

用途：下一次推送到达时，与这份基线逐节点比较，得到端点视角的新增/修改/移动/删除操作。基线在每次成功合并后替换。

---

## 7. Change（变更记录 / 操作）

| 字段 | 类型 | 说明 |
|---|---|---|
| `seq` | integer | 全局单调递增序号，由中继分配 |
| `type` | `add \| update \| move \| delete \| undelete` | 操作类型 |
| `syncId` | string | 目标节点 |
| `payload` | object | 变更后的字段（`add/update/move`）或删除原因（`delete`） |
| `origin` | string | 产生该变更的端点 |
| `at` | integer | 操作时间（由端点提供，中继记录接收时间用于审计） |

---

## 8. CanonicalState（中继规范状态）

```text
CanonicalState {
  schemaVersion: 1
  seq: integer
  nodes: Map<syncId, SyncNode>
  tombstones: Map<syncId, Tombstone>
  endpoints: Map<endpointId, Endpoint>
  snapshots: Map<endpointId, EndpointSnapshot>
  changes: Change[]        // 按 seq 排序，保留最近 N 条供重放
}
```

持久化：`relay/data/state.json`（临时文件 + 原子重命名）；启动时校验 `schemaVersion` 与结构，损坏则回退到最近备份。

---

## 9. 合并规则（确定性顺序）

对每个端点推送，按以下顺序处理：

1. **差异计算**: `push.nodes` 对比 `EndpointSnapshot.nodes`，得到操作集合。
2. **身份解析**: 无 `syncId` 的节点按 §3 绑定或分配。
3. **删除检查（双向镜像）**: 端点上报的删除按到达顺序生效。若规范状态中的节点在该端点上次快照之后被另一端修改，删除仍然生效，并记录 `delete_vs_edit`（`resolution: delete_wins`）。
4. **复活检查**: 对已删除节点收到内容与墓碑不同的 `update/move` → `undelete`（修改晚于删除，后到者胜），并记录 `delete_vs_edit`（`resolution: keep_modified`）。
5. **新增合并**: `add` 命中已存在 `syncId` → 转为 `update`；内容键相同且位于同一父级 → 合并为一条（FR-008）。
6. **并列裁决**: `modifiedAt` 相同时，`rev` 大者胜；仍相同则 `origin` 字典序大者胜（确定性，两端一致）。
7. **位置规整**: 同一父级下按 `position` 排序后重排为 `0..n-1`；位置相同按 `createdAt`、`syncId` 排序。
8. **序号分配**: 每个实际改变规范状态的操作分配新 `seq`；无变化则不递增。
9. **基线替换**: 用本次推送树替换该端点的 `EndpointSnapshot`。

---

## 10. 状态转换

```text
          add                delete(时间>=modifiedAt)
  (不存在) ──▶ active ─────────────────────────────▶ deleted
                ▲                                    │
                │        update/move(时间>deletedAt)  │
                └────────────────────────────────────┘
                              undelete

  deleted ──(所有端点已确认 + 30 天)──▶ purged (不可复活)
```

---

## 11. 校验规则

| 规则 | 处理 |
|---|---|
| `kind=bookmark` 但 `url` 为空 | 拒绝该节点，记录协议错误 |
| `kind=folder` 但 `url` 非空 | 将 `url` 置空并记录警告 |
| `parentSyncId` 不存在 | 若同批次中存在则先创建；否则挂到 `other` 根并记警告 |
| 出现环（A 是 B 的祖先且 B 是 A 的祖先） | 拒绝该 `move`，保留原父级，记冲突 |
| `title` 超过 4096 字符 | 截断并记警告 |
| `url` 超过 65536 字符 | 拒绝该节点，记错误 |
| 同一 `syncId` 在同一批次出现两次 | 拒绝整个批次（协议错误） |
| `position` 为负或非整数 | 置为末尾并记警告 |
| 根节点 `bookmark_bar` / `other` 被删除 | 拒绝（根不可删） |
| 规范状态出现两个同 `contentKey` 同父级节点 | 允许（真实重复），不做自动清理 |

---

## 12. 合并不变量（供测试断言）

| 编号 | 不变量 |
|---|---|
| INV-1 | **并集**: 任一端新增且未被删除的节点，在合并完成后存在于规范状态（FR-003）。 |
| INV-2 | **唯一性**: `syncId` 全局唯一，同一父级下不存在由同步产生的意外重复。 |
| INV-3 | **删除不复活**: 无"删除后修改"事件时，已删除节点不得重新出现（FR-005）。 |
| INV-4 | **幂等**: 重复推送同一棵树，不产生新的 `seq` 与实际状态变化（FR-016）。 |
| INV-5 | **收敛**: 两个端点拉取到同一 `lastSeq` 后，忽略本地编号的书签树同构。 |
| INV-6 | **结构合法**: 无环、根固定、每个节点都有合法父级或根。 |
| INV-7 | **镜像一致**: 冲突裁决后两端最终一致；后到删除可以覆盖先到修改，这是双向镜像的预期行为（FR-006）；除此之外不产生非预期丢失（SC-007）。 |
| INV-8 | **确定性**: 相同输入与相同操作顺序，两端得到完全相同的规范状态。 |
