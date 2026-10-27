# Implementation Plan: 浏览器书签双向同步插件

**Branch**: `001-bookmark-sync` | **Date**: 2026-10-27 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-bookmark-sync/spec.md`

## Summary

为 Chrome 与 ego lite 提供一个共用同一套 MV3 浏览器扩展的书签双向同步能力。扩展通过 `chrome.bookmarks` 读取和写入本 Profile 的书签树，把书签树与本地基线做差异计算，经 `ws://127.0.0.1` 上的本机中继合并为规范状态；合并采用**双向镜像 + 墓碑删除**：两端最终保持完全一致，删除能够传播且不复活；同一书签两端都改过时，按中继到达顺序后到者胜。合并引擎是与浏览器 API 无关的纯 TypeScript 包，便于用单元测试覆盖全部边界场景；中继仅监听回环地址，不引入云端与账号体系。

## Technical Context

**Language/Version**: TypeScript 5.6；Node.js 22.14（本机已安装）；浏览器扩展目标 Chromium Manifest V3（本机 Chrome 155、ego lite 0.6.0.16）

**Primary Dependencies**: 扩展仅依赖平台 API（`chrome.bookmarks`、`chrome.storage`、`chrome.alarms`），用 esbuild 打包；中继使用 `ws`（WebSocket）与 `zod`（消息校验）；测试使用 Vitest 与 Playwright

**Storage**: 中继侧使用单个 JSON 状态文件并采用"写临时文件 + 原子重命名"持久化（规模 ≤10k 书签，无需数据库）；扩展侧使用 `chrome.storage.local` 保存端点标识、`localId → syncId` 映射、同步基线与回滚快照索引

**Testing**: Vitest 覆盖合并引擎与协议契约（含属性测试风格的随机合并场景）；Playwright 以持久化上下文在 Chrome 中加载扩展做端到端验证；ego lite 侧提供手工验收清单（其自动化驱动能力未确认）

**Target Platform**: Windows 11；Chrome 155；ego lite 0.6.0.16（Chromium）；同一台电脑

**Project Type**: 桌面工具——浏览器扩展 + 本机后台服务组成的小型单体仓库

**Performance Goals**: 两端在线时变更在 10 秒内可见；1,000 条书签、5 层文件夹首次合并 60 秒内完成；中继在 10,000 条书签规模下常驻内存低于 100MB

**Constraints**: 中继只监听 `127.0.0.1`；不依赖任何云服务或账号；MV3 Service Worker 会被浏览器回收，必须可重新连接并断点续传；ego lite 加载未上架的本地扩展已在本机 0.6.0.16 实测通过（2026-10-27，见 `research.md` R1），不再作为风险项

**Scale/Scope**: 2 个同步端点（Chrome 一个 Profile + ego 指定一个 Profile）；≤10,000 条书签；单机部署

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` 目前仍是未填写的模板（全部为占位符），项目尚无已批准的原则与质量门禁，因此没有可校验的门禁条目。

- **Gate result**: PASS（无已定义门禁）。
- **Note**: 建议在进入实现前运行 `/speckit-constitution` 批准项目原则，否则后续 `/speckit-analyze` 与实现阶段无法做原则一致性检查。
- **Design posture**: 本计划已按保守默认约束设计——本地优先、无云端依赖、合并核心与浏览器 API 解耦且可独立测试、任何冲突以"不丢失用户书签"优先。

**Post-Phase 1 re-check**: PASS。Phase 1 产物（`data-model.md`、`contracts/relay-protocol.md`、`quickstart.md`）未引入新的服务依赖、云组件或超出规格的复杂度；合并核心仍为纯函数包，回环抑制与持久化边界清晰。无宪法门禁需要重新校验。

## Project Structure

### Documentation (this feature)

```text
specs/001-bookmark-sync/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
│   └── relay-protocol.md
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
core/                          # 纯 TypeScript：协议类型、身份规则、合并引擎
├── src/
│   ├── model.ts               # 规范书签/文件夹/墓碑类型
│   ├── identity.ts            # 内容键、syncId 映射与匹配
│   ├── diff.ts                # 端点快照差异（新增/修改/移动/删除）
│   ├── merge.ts               # 并集合并、墓碑、冲突裁决
│   └── protocol.ts            # 扩展 ↔ 中继消息类型与校验
└── tests/
    ├── merge.test.ts
    ├── identity.test.ts
    ├── delete.test.ts
    ├── structure.test.ts
    └── invariants.test.ts

extension/                     # MV3 扩展，Chrome 与 ego 共用同一份产物
├── manifest.json
├── src/
│   ├── background/
│   │   ├── service-worker.ts  # 生命周期、连接、调度
│   │   ├── bookmarks-adapter.ts # chrome.bookmarks 读写与树快照
│   │   ├── sync-client.ts     # 推送/拉取/应用变更
│   │   └── loop-guard.ts      # 自身写入抑制与基线推进
│   ├── ui/
│   │   ├── popup.ts           # 状态、暂停/恢复、立即同步
│   │   └── options.ts         # 中继地址、令牌、Profile 选择
│   └── lib/
├── public/
└── tests/

relay/                         # 本机中继服务
├── src/
│   ├── server.ts              # WebSocket 服务、鉴权、健康检查
│   ├── state-store.ts         # 规范状态、原子持久化、备份
│   └── session.ts             # 端点会话、序号与确认
└── tests/
    ├── protocol.test.ts
    └── store.test.ts

tests/
├── integration/               # core + relay 的端到端合并
└── e2e/                       # Playwright 加载扩展验证

scripts/
├── build.mjs                  # 打包扩展、编译中继
└── smoke.mjs                  # 启动中继并跑一次协议冒烟

package.json                   # npm workspaces: core, extension, relay
tsconfig.base.json
```

**Structure Decision**: 采用三包工作区。`core` 不依赖任何浏览器或 Node 专有 API，是全部合并规则的唯一实现，保证边界场景可用快速单元测试覆盖；`extension` 只负责浏览器读写、基线与回环抑制；`relay` 只负责会话、序号与持久化。这样即使 ego 最终无法加载扩展、需要换成文件桥接，`core` 与合并语义也可以原样复用。

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

无。当前没有已批准的宪法门禁，且本设计未引入额外服务、数据库或跨设备同步等超出规格的复杂度。
