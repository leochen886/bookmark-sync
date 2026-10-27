# Contract: 扩展 ↔ 本机中继协议

**Feature**: `001-bookmark-sync` | **Version**: 1 | **Date**: 2026-10-27

本契约定义浏览器扩展与本机中继之间的唯一接口。两端都按本文件实现；`core/src/protocol.ts` 中的类型是契约的代码表达。

---

## 1. 传输与端点

| 项 | 值 |
|---|---|
| WebSocket | `ws://127.0.0.1:8787/ws`（仅回环地址） |
| 健康检查 | `GET http://127.0.0.1:8787/health`（无需鉴权，返回最少信息） |
| 帧格式 | 单条 JSON 文本帧；禁止二进制帧 |
| 最大帧 | 8 MiB；超过返回 `PAYLOAD_TOO_LARGE` 并关闭连接 |
| 编码 | UTF-8，`Content-Type` 不适用 |
| 并发 | 每个 `endpointId` 同时只允许一个连接；新连接会关闭旧连接（关闭码 `4409`） |

### 健康检查响应

```json
{
  "status": "ok",
  "version": "1.0.0",
  "seq": 128,
  "endpointsOnline": 2,
  "uptimeSec": 3600
}
```

不包含书签内容、令牌或 Profile 名称。

---

## 2. 消息信封

所有消息共享以下头部字段：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `v` | integer | 是 | 协议版本，当前为 `1` |
| `type` | string | 是 | 消息类型 |
| `requestId` | string | 视类型 | 请求/响应配对；客户端生成 |
| `ts` | integer | 是 | 发送方时间戳（epoch ms） |

服务端对未知 `type` 返回 `BAD_REQUEST`，不断开连接；对未知字段忽略。

---

## 3. 握手

### 3.1 `hello`（客户端 → 中继）

```json
{
  "v": 1,
  "type": "hello",
  "requestId": "c-1",
  "ts": 1761530000000,
  "endpointId": "a1b2c3d4:ego:Profile 2",
  "installId": "a1b2c3d4-...",
  "browser": "ego",
  "profileLabel": "Profile 2",
  "clientVersion": "1.0.0",
  "token": "<中继启动时生成并展示的令牌>",
  "lastSeq": 42
}
```

### 3.2 `welcome`（中继 → 客户端）

```json
{
  "v": 1,
  "type": "welcome",
  "requestId": "c-1",
  "ts": 1761530000100,
  "serverVersion": "1.0.0",
  "seq": 128,
  "lastSeq": 42,
  "resume": "incremental",
  "endpointStatus": "online"
}
```

`resume` 取值：

| 值 | 含义 | 客户端后续动作 |
|---|---|---|
| `incremental` | 中继仍保留 `lastSeq` 之后的变更 | 直接 `pull` |
| `snapshot` | 变更已被清理或序号无效 | 先 `resync` 获取完整状态 |

### 3.3 鉴权失败

中继返回：

```json
{ "v": 1, "type": "error", "ts": 1761530000200, "code": "AUTH_FAILED", "message": "invalid token" }
```

随后以关闭码 `4401` 关闭连接。

---

## 4. 推送本地书签树

### 4.1 `push`（客户端 → 中继）

```json
{
  "v": 1,
  "type": "push",
  "requestId": "c-2",
  "ts": 1761530001000,
  "baseSeq": 42,
  "snapshotHash": "sha256:9f2c...",
  "dryRun": false,
  "snapshot": {
    "roots": ["bookmark_bar", "other"],
    "nodes": [
      {
        "localId": "1",
        "parentLocalId": null,
        "rootKey": "bookmark_bar",
        "kind": "folder",
        "title": "书签栏",
        "url": null,
        "position": 0,
        "dateAdded": 1700000000000,
        "syncId": null,
        "modifiedAt": null
      },
      {
        "localId": "57",
        "parentLocalId": "1",
        "rootKey": null,
        "kind": "bookmark",
        "title": "Example",
        "url": "https://example.com/",
        "position": 3,
        "dateAdded": 1761520000000,
        "syncId": null,
        "modifiedAt": null
      }
    ]
  }
}
```

字段说明：

| 字段 | 说明 |
|---|---|
| `baseSeq` | 客户端生成该快照时已应用到的中继序号 |
| `snapshotHash` | 对 `snapshot` 规范化后的 SHA-256；用于幂等与预演确认 |
| `dryRun` | `true` 时只计算差异并返回预览，不修改规范状态 |
| `nodes[].localId` | 浏览器本地编号，仅用于本次消息内引用与回传映射 |
| `nodes[].syncId` | 已绑定节点的身份；新节点为 `null` |
| `nodes[].modifiedAt` | 扩展记录的最近修改时间；未知时为 `null`（中继以 `dateAdded` 兜底） |

根节点（`rootKey` 非空）必须存在且不可删除；`synced` 根不参与同步，客户端不得发送。

### 4.2 `push-result`（中继 → 客户端）

```json
{
  "v": 1,
  "type": "push-result",
  "requestId": "c-2",
  "ts": 1761530001100,
  "seq": 135,
  "applied": false,
  "dryRun": false,
  "counts": {
    "added": 1,
    "updated": 0,
    "moved": 0,
    "deleted": 0,
    "resurrected": 0,
    "conflicts": 1
  },
  "bindings": [
    { "localId": "57", "syncId": "3f2a8c1e-..." }
  ],
  "conflicts": [
    {
      "syncId": "9d1e...",
      "kind": "delete_vs_edit",
      "resolution": "keep_modified",
      "detail": "remote deleted at 1761530000000; local modified at 1761530010000"
    }
  ]
}
```

`applied: false` 表示本次推送未改变规范状态（幂等命中或 `dryRun`）。

`bindings` 仅在下列情况返回：新节点被分配 `syncId`，或首次配对按内容键匹配到已有 `syncId`。客户端必须持久化这些映射。

### 4.3 首次配对预演与确认

为保证 FR-011，首次配对必须使用两阶段流程：

1. 客户端发送 `push`，`dryRun: true`。
2. 中继完成身份匹配与差异计算，返回 `push-result`（`dryRun: true`，`seq` 不变），并把该预演缓存在内存中（TTL 5 分钟，按 `requestId`）。
3. 客户端展示 `counts` 与冲突摘要，用户确认后发送：

```json
{
  "v": 1,
  "type": "commit",
  "requestId": "c-3",
  "ts": 1761530002000,
  "previewRequestId": "c-2",
  "snapshotHash": "sha256:9f2c..."
}
```

4. 中继校验 `previewRequestId` 与 `snapshotHash` 一致后提交，返回 `push-result`（`dryRun: false`）。
5. 预演过期或哈希不一致 → `PREVIEW_EXPIRED` / `HASH_MISMATCH`，客户端需重新预演。

已配对之后的常规同步可直接 `push`（`dryRun` 省略或 `false`）。

---

## 5. 拉取变更

### 5.1 `pull`（客户端 → 中继）

```json
{
  "v": 1,
  "type": "pull",
  "requestId": "c-4",
  "ts": 1761530003000,
  "sinceSeq": 42,
  "limit": 500
}
```

`limit` 默认 500，最大 2000；`sinceSeq` 为客户端已确认应用的最大序号。

### 5.2 `ops`（中继 → 客户端）

```json
{
  "v": 1,
  "type": "ops",
  "requestId": "c-4",
  "ts": 1761530003100,
  "seq": 135,
  "hasMore": false,
  "changes": [
    {
      "seq": 129,
      "type": "add",
      "syncId": "3f2a8c1e-...",
      "origin": "a1b2c3d4:ego:Profile 2",
      "at": 1761530000500,
      "payload": {
        "kind": "bookmark",
        "title": "Example",
        "url": "https://example.com/",
        "parentSyncId": "root:bookmark_bar",
        "position": 3
      }
    },
    {
      "seq": 130,
      "type": "delete",
      "syncId": "9d1e...",
      "origin": "chrome:Default",
      "at": 1761530000600,
      "payload": { "reason": "user_delete" }
    }
  ]
}
```

变更类型与 `payload`：

| `type` | `payload` |
|---|---|
| `add` | `kind`, `title`, `url`, `parentSyncId`, `position` |
| `update` | 变化后的 `title` / `url`（至少一个） |
| `move` | `parentSyncId`, `position` |
| `delete` | `reason` |
| `undelete` | `kind`, `title`, `url`, `parentSyncId`, `position`，表示删除后修改导致的复活 |

根节点的 `parentSyncId` 使用固定值 `root:bookmark_bar` / `root:other`。

### 5.3 `ack`（客户端 → 中继）

客户端成功应用变更后发送：

```json
{ "v": 1, "type": "ack", "ts": 1761530004000, "seq": 135 }
```

中继据此推进该端点的 `lastSeq`，并据此判断墓碑何时可清理。`ack` 无响应消息。

---

## 6. 全量重同步

### 6.1 `resync`（客户端 → 中继）

```json
{ "v": 1, "type": "resync", "requestId": "c-5", "ts": 1761530005000 }
```

### 6.2 `snapshot`（中继 → 客户端）

```json
{
  "v": 1,
  "type": "snapshot",
  "requestId": "c-5",
  "ts": 1761530005100,
  "seq": 135,
  "nodes": [
    {
      "syncId": "3f2a8c1e-...",
      "kind": "bookmark",
      "title": "Example",
      "url": "https://example.com/",
      "parentSyncId": "root:bookmark_bar",
      "position": 3,
      "createdAt": 1761520000000,
      "modifiedAt": 1761530000500,
      "deleted": false
    }
  ],
  "tombstones": [
    { "syncId": "9d1e...", "deletedAt": 1761530000600, "seq": 130 }
  ]
}
```

客户端收到后必须以 `snapshot` 为准重建本地书签（保留用户在此期间的新增：先记录本地新增，重建后作为下一轮 `push` 补齐），然后 `ack` `seq`。

---

## 7. 心跳与连接维护

| 消息 | 方向 | 说明 |
|---|---|---|
| `ping` | 双方可发 | `{ "v":1, "type":"ping", "ts":... }` |
| `pong` | 对方回 | 原样带回 `ts` |

- 客户端每 25 秒发送一次 `ping`；45 秒无任何消息视为断线，按 1s、2s、4s…30s 指数退避重连。
- 中继对 90 秒无消息的连接主动关闭（关闭码 `4408`）。
- 重连后必须重新 `hello`，并携带最新 `lastSeq`。

---

## 8. 错误

```json
{
  "v": 1,
  "type": "error",
  "requestId": "c-2",
  "ts": 1761530006000,
  "code": "SEQ_GAP",
  "message": "baseSeq 40 is behind retained changes (first retained: 120)",
  "retryable": true
}
```

| `code` | 含义 | `retryable` | 客户端动作 |
|---|---|---|---|
| `BAD_REQUEST` | 消息结构或字段非法 | 否 | 修正后重发；记录日志 |
| `AUTH_FAILED` | 令牌错误 | 否 | 提示用户在设置中更新令牌 |
| `UNKNOWN_ENDPOINT` | 端点未注册 | 否 | 重新 `hello` 注册 |
| `SEQ_GAP` | `baseSeq` 早于中继保留窗口 | 是 | 先 `resync` 再 `push` |
| `PREVIEW_EXPIRED` | 预演超过 5 分钟 | 是 | 重新 `dryRun` |
| `HASH_MISMATCH` | 预演哈希与提交不一致 | 是 | 重新 `dryRun` |
| `PAYLOAD_TOO_LARGE` | 快照超过 8 MiB | 否 | 记录错误；等待分片能力（v1 不支持） |
| `STATE_BUSY` | 中继正在写入或恢复 | 是 | 1 秒后重试 |
| `INTERNAL` | 未预期错误 | 是 | 指数退避重试 |

致命错误（`AUTH_FAILED`、`PAYLOAD_TOO_LARGE`）随后关闭连接；其余错误保持连接。

---

## 9. 幂等与顺序保证

1. 同一 `snapshotHash` + 相同 `baseSeq` 的重复 `push` 必须返回 `applied: false`，不分配新 `seq`（FR-016、INV-4）。
2. `seq` 由中继单点分配，全局单调递增；同一端点的 `pull` 结果必须严格按 `seq` 升序。
3. 客户端必须按 `seq` 顺序应用变更，并在成功应用后 `ack`；跳过 `ack` 不会导致数据丢失，但会延迟墓碑清理。
4. 一个端点重连时，中继以新连接为准，旧连接关闭码 `4409`；旧连接未 `ack` 的变更会重新发送。

---

## 10. 安全边界

- 仅监听 `127.0.0.1`，拒绝非回环来源的连接。
- 令牌在首次启动时生成，写入 `relay/data/token.txt` 并在控制台打印一次；扩展设置中保存。
- 中继不记录书签内容到日志；错误日志只包含 `syncId`、端点 ID 与计数。
- `/health` 不返回任何书签数据或令牌。
- 中继不接受远程配置、不发起外连。

---

## 11. 示例：一次两端新增的完整时序

```text
ego 新增 A                      Chrome 新增 B
   │                               │
   ├─ push(baseSeq=10) ───────────▶│
   │◀──────────── push-result(seq=11, added=1) ─┐
   │                                             │
   │                               ├─ push(baseSeq=10) ─────▶
   │                                             │◀─ push-result(seq=12, added=1)
   │◀─ ops(sinceSeq=11) [add B] ─────────────────┤
   │   apply B, ack(12)                           │
   │                               ◀─ ops(sinceSeq=12) [add A] ─┤
   │                                             │  apply A, ack(12)
   ▼                                             ▼
两端均含 A、B，各一份
```
