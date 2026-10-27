# Validation Record: 浏览器书签双向同步插件

**Date**: 2026-10-27
**Feature**: `001-bookmark-sync`

本文件记录自动化验收结果，以及仍需在真实 ego lite 上人工执行的步骤。自动化 E2E 使用 Playwright 的 Chrome for Testing，**不等同于**真实 ego 二进制；真实 ego 的加载能力已在 T001 验证，但完整同步流程仍需人工过一遍。

---

## 1. 环境

| 项 | 版本 |
|---|---|
| OS | Windows 11 Education 10.0.26300 |
| Node.js | v22.14.0 |
| npm | 10.9.2 |
| Chrome | 155（系统安装） |
| ego lite | 0.6.0.16（用户数据在 `%LOCALAPPDATA%\Citro Labs\ego lite\User Data`） |
| Playwright | 1.49.1 |
| Playwright Chromium | Chrome for Testing 156.0.8078.4 |

---

## 2. 自动化结果

### 2.1 类型与单元测试

```text
npm run typecheck  → exit 0
npm test           → 8 files / 29 tests passed
```

| 测试文件 | 数量 | 覆盖 |
|---|---|---|
| `core/tests/merge.test.ts` | 6 | 并集、内容去重、同 URL 不同文件夹、改名、身份唯一 |
| `core/tests/delete.test.ts` | 5 | 墓碑、父级级联、删除 vs 修改、复活、陈旧副本不复活 |
| `core/tests/structure.test.ts` | 7 | 层级、移动、改名刷新、循环、位置规整、重复身份、diff move |
| `core/tests/invariants.test.ts` | 1 | 1,000 组随机树与操作序列，断言并集/结构/墓碑/幂等/确定性 |
| `relay/tests/protocol.test.ts` | 4 | 预演→提交→拉取、双端合并、哈希不匹配、无效令牌 4401 |
| `relay/tests/session.test.ts` | 2 | 重复 push 不增 seq、ack 丢失重放、重连续传 |
| `relay/tests/tombstone-gc.test.ts` | 3 | 30 天 + 全部端点确认后的墓碑清理 |
| `tests/integration/scale.test.ts` | 1 | 1,000 条书签 / 5 层文件夹 |

### 2.2 规模

`tests/integration/scale.test.ts` 实测：

```text
1000 bookmarks, 5 folder levels
first endpoint merge: 151 ms
second endpoint (content matching): 189 ms
nodes: 1007
```

远低于 SC-004 的 60 秒预算。

### 2.3 不变量对拍

`core/tests/invariants.test.ts`：1,000 组随机用例，耗时约 1.18 秒。覆盖：

- 并集：两端所有书签 URL 在 canonical 中存在且只有一份
- 结构：父节点存在、无环、位置连续、书签有 URL、文件夹 URL 为空
- 删除：共享书签删除后产生墓碑，陈旧端点重推不复活
- 幂等：同一棵树重复推送不产生变更
- 确定性：相同输入序列在全新状态上得到完全相同的数据

### 2.4 端到端（Playwright）

```text
npm run test:e2e → 8 passed (58.4s)
```

| 用例 | 耗时 | 结果 |
|---|---|---|
| 双端各新增一个书签，两端都保留 | 5.2s | PASS |
| 书签删除传播，4 秒后不复活 | 9.4s | PASS |
| 删除文件夹级联删除子书签 | 8.4s | PASS |
| 三层文件夹、改名、书签移动到书签栏 | 7.0s | PASS |
| 文件夹移动到另一文件夹 | 5.3s | PASS |
| 断线两端各新增，重启中继后追平 | 8.7s | PASS |
| 暂停期间不写入，恢复后补齐 | 同上用例 | PASS |
| 删除 vs 改名：两端收敛、冲突可见 | 6.7s | PASS |
| 配对前两端已有同名书签：不产生重复 | 6.5s | PASS |

E2E 使用两个隔离的 Chromium Profile（分别标记 `chrome` 与 `ego`），加载真实构建产物 `extension/dist`，连接真实中继进程。配对通过真实 options 页完成，冲突通过真实弹窗页面验证。

### 2.5 冒烟

```text
npm run smoke     → health: {"status":"ok", ...}
npm run smoke:ws  → ws smoke ok: resume=incremental seq=0 changes=0
```

---

## 3. 成功标准映射

| 标准 | 验证方式 | 结果 |
|---|---|---|
| SC-001 两端新增都保留、无重复 | 单元测试 + E2E union-add | PASS |
| SC-002 删除 10 秒内传播且不复活 | E2E delete | PASS |
| SC-003 改名/移动 10 秒内跟随 | E2E structure | PASS |
| SC-004 1,000 条 / 5 层首次合并 < 60 秒 | 集成测试 151ms / 189ms | PASS |
| SC-005 连续 1 小时无重复、无回环抖动 | 未执行 1 小时长跑；短时 E2E 无重复 | **PARTIAL / 待长跑** |
| SC-006 中继中断 10 分钟内恢复、无丢失 | E2E offline 8.9s 追平 | PASS |
| SC-007 冲突后两端一致、无非预期丢失 | 不变量测试 + 冲突 E2E（镜像后到者胜） | PASS |

---

## 4. Quickstart V1–V8

| 场景 | 自动化等价项 | 状态 |
|---|---|---|
| V1 双端新增合并 | E2E union-add | PASS（Chromium） |
| V2 删除传播、不复活 | E2E delete | PASS（Chromium） |
| V3 文件夹、改名、移动 | E2E structure | PASS（Chromium） |
| V4 1,000 条规模 | integration scale | PASS |
| V5 断线恢复 | E2E offline | PASS（Chromium） |
| V6 1 小时回环/抖动 | 未执行 | **待人工长跑** |
| V7 冲突后到者胜并收敛 | E2E offline conflict | PASS（Chromium） |
| V8 多 Profile 隔离 | 仅 T001 验证扩展加载 | **待真实 ego 多 Profile 人工验证** |

---

## 5. 真实 ego lite 人工验收

### 5.1 已完成

- **T001（2026-10-27）**：在 ego lite 0.6.0.16 中成功加载最小 MV3 扩展；`bookmarks`、`storage`、`alarms` API 均可用；`chrome.bookmarks.getTree()` 读取到 170 个节点。截图：`C:\Users\CL\Desktop\屏幕截图 2026-10-27 153106.png`。

### 5.2 待执行（需要用户在 ego 中操作）

1. `npm run build && npm run relay`
2. 在 ego 的目标 Profile 中加载 `extension/dist`
3. 在 Chrome 中也加载 `extension/dist`
4. 两端设置中填写同一令牌与中继地址
5. 依次执行 quickstart V1–V8

建议优先确认：

- **V8**：只在 `Profile 2` 配置扩展，检查 `Profile 3` 的书签零变化
- **V6**：两端保持在线 1 小时，确认空闲时 `seq` 不增长、书签总数不膨胀
- **V1/V2**：真实 ego 与 Chrome 之间的新增与删除

执行后把结果、耗时与截图路径补充到本文件第 4/5 节。

---

## 6. 2026-10-27 重复事故与修复

真实 Chrome ↔ ego 首次配对后出现"每条书签两份"。

**现象**

- canonical：308 条书签 / 26 个文件夹，实为 154 / 13 的两份副本
- 13 对文件夹的子树逐项比对完全一致；根目录另有 9 对相同书签

**根因**

- 两端本来各有同一套书签
- 应用远端新增时，本地已有同内容书签但尚未建立 `syncId` 绑定，扩展**又创建了一份**
- 未完成配对时也应用了远端 ops，放大了这个问题

**修复**

- `findLocalContentMatch`：应用新增前先按「父级 + 标题 + URL」认领本地已有节点
- `flushOps`：未配对或暂停时直接丢弃远端 ops，配对后由 pull/snapshot 补齐
- 新增 `tests/e2e/prepair.spec.ts` 回归测试（配对前两端已有同名书签，断言不重复）

**清理**

- 备份：`relay/data/state.pre-dedupe-2026-10-27T08-58-25-681Z.json`
- `scripts/dedupe-state.mjs`：删除 13 个重复文件夹 + 154 条重复书签
- 结果：154 条书签 / 13 个文件夹 / 0 组重复；`seq=401`，清空变更日志强制两端从快照重同步

## 7. 已知未覆盖项

| 项 | 说明 |
|---|---|
| 真实 ego 全流程 | E2E 用 Chromium 双 Profile 替代；ego 仅验证了扩展加载与 API |
| 1 小时长跑 | SC-005 尚未用完整 1 小时验证 |
| 多 Profile 隔离 | 逻辑上扩展天然按 Profile 隔离，但未在真实 ego 上逐 Profile 验证 |
| 10,000 条上限 | 只测到 1,000 条；10,000 条未压测 |
| 跨设备/云 | v1 明确不支持 |
