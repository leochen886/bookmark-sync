import { z } from "zod";

export const PROTOCOL_VERSION = 1;

const RootKeySchema = z.enum(["bookmark_bar", "other"]);
const NodeKindSchema = z.enum(["bookmark", "folder"]);
const BrowserSchema = z.enum(["chrome", "ego"]);
const ChangeTypeSchema = z.enum(["add", "update", "move", "delete", "undelete"]);
const EndpointStatusSchema = z.enum(["online", "offline", "paused"]);

const EnvelopeSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  ts: z.number().int().nonnegative(),
});

const RequestSchema = EnvelopeSchema.extend({
  requestId: z.string().min(1),
});

export const ErrorCodeSchema = z.enum([
  "BAD_REQUEST",
  "AUTH_FAILED",
  "UNKNOWN_ENDPOINT",
  "SEQ_GAP",
  "PREVIEW_EXPIRED",
  "HASH_MISMATCH",
  "PAYLOAD_TOO_LARGE",
  "STATE_BUSY",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

// --- client -> relay -------------------------------------------------------

export const HelloSchema = RequestSchema.extend({
  type: z.literal("hello"),
  endpointId: z.string().min(1),
  installId: z.string().min(1),
  browser: BrowserSchema,
  profileLabel: z.string().min(1),
  clientVersion: z.string().min(1),
  token: z.string().min(1),
  lastSeq: z.number().int().nonnegative(),
});

export const PushNodeSchema = z.object({
  localId: z.string().min(1),
  parentLocalId: z.string().nullable(),
  rootKey: RootKeySchema.nullable(),
  kind: NodeKindSchema,
  title: z.string(),
  url: z.string().nullable(),
  position: z.number().int(),
  dateAdded: z.number().int(),
  syncId: z.string().nullable().optional(),
  modifiedAt: z.number().int().nullable().optional(),
});

export const PushSchema = RequestSchema.extend({
  type: z.literal("push"),
  baseSeq: z.number().int().nonnegative(),
  snapshotHash: z.string().min(1),
  dryRun: z.boolean().optional(),
  snapshot: z.object({
    roots: z.array(RootKeySchema),
    nodes: z.array(PushNodeSchema).max(50000),
  }),
});

export const CommitSchema = RequestSchema.extend({
  type: z.literal("commit"),
  previewRequestId: z.string().min(1),
  snapshotHash: z.string().min(1),
});

export const PullSchema = RequestSchema.extend({
  type: z.literal("pull"),
  sinceSeq: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(2000).optional(),
});

export const AckSchema = EnvelopeSchema.extend({
  type: z.literal("ack"),
  seq: z.number().int().nonnegative(),
});

export const ResyncSchema = RequestSchema.extend({
  type: z.literal("resync"),
});

export const PingSchema = EnvelopeSchema.extend({
  type: z.literal("ping"),
});

export const ClientMessageSchema = z.discriminatedUnion("type", [
  HelloSchema,
  PushSchema,
  CommitSchema,
  PullSchema,
  AckSchema,
  ResyncSchema,
  PingSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type HelloMessage = z.infer<typeof HelloSchema>;
export type PushMessage = z.infer<typeof PushSchema>;
export type CommitMessage = z.infer<typeof CommitSchema>;
export type PullMessage = z.infer<typeof PullSchema>;
export type AckMessage = z.infer<typeof AckSchema>;

// --- relay -> client -------------------------------------------------------

export const WelcomeSchema = RequestSchema.extend({
  type: z.literal("welcome"),
  serverVersion: z.string().min(1),
  seq: z.number().int().nonnegative(),
  lastSeq: z.number().int().nonnegative(),
  resume: z.enum(["incremental", "snapshot"]),
  endpointStatus: EndpointStatusSchema,
});

export const CountsSchema = z.object({
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  moved: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  resurrected: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
});
export type Counts = z.infer<typeof CountsSchema>;

export const ConflictSchema = z.object({
  syncId: z.string(),
  kind: z.enum([
    "delete_vs_edit",
    "move_cycle",
    "duplicate_sync_id",
    "missing_parent",
    "invalid_position",
  ]),
  resolution: z.enum([
    "keep_modified",
    "delete_wins",
    "reject_move",
    "attach_to_other",
    "move_to_end",
    "reject_batch",
  ]),
  detail: z.string(),
});
export type Conflict = z.infer<typeof ConflictSchema>;

export const BindingSchema = z.object({
  localId: z.string(),
  syncId: z.string(),
});

export const PushResultSchema = RequestSchema.extend({
  type: z.literal("push-result"),
  seq: z.number().int().nonnegative(),
  applied: z.boolean(),
  dryRun: z.boolean(),
  counts: CountsSchema,
  bindings: z.array(BindingSchema),
  conflicts: z.array(ConflictSchema),
});

export const ChangePayloadSchema = z.object({
  kind: NodeKindSchema.optional(),
  title: z.string().optional(),
  url: z.string().nullable().optional(),
  parentSyncId: z.string().nullable().optional(),
  position: z.number().int().optional(),
  reason: z.enum(["user_delete", "parent_delete"]).optional(),
});

export const ChangeSchema = z.object({
  seq: z.number().int().nonnegative(),
  type: ChangeTypeSchema,
  syncId: z.string(),
  origin: z.string(),
  at: z.number().int(),
  payload: ChangePayloadSchema,
});

export const OpsSchema = RequestSchema.extend({
  type: z.literal("ops"),
  seq: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  changes: z.array(ChangeSchema),
});

export const CanonicalNodeSchema = z.object({
  syncId: z.string(),
  kind: NodeKindSchema,
  title: z.string(),
  url: z.string().nullable(),
  parentSyncId: z.string().nullable(),
  rootKey: RootKeySchema.nullable().optional(),
  position: z.number().int(),
  createdAt: z.number().int(),
  modifiedAt: z.number().int(),
  deleted: z.boolean(),
});

export const TombstoneSchema = z.object({
  syncId: z.string(),
  deletedAt: z.number().int(),
  seq: z.number().int().nonnegative(),
});

export const SnapshotSchema = RequestSchema.extend({
  type: z.literal("snapshot"),
  seq: z.number().int().nonnegative(),
  nodes: z.array(CanonicalNodeSchema),
  tombstones: z.array(TombstoneSchema),
});

export const PongSchema = EnvelopeSchema.extend({
  type: z.literal("pong"),
});

export const ErrorSchema = EnvelopeSchema.extend({
  type: z.literal("error"),
  requestId: z.string().optional(),
  code: ErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
});

export const ServerMessageSchema = z.discriminatedUnion("type", [
  WelcomeSchema,
  PushResultSchema,
  OpsSchema,
  SnapshotSchema,
  PongSchema,
  ErrorSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type WelcomeMessage = z.infer<typeof WelcomeSchema>;
export type PushResultMessage = z.infer<typeof PushResultSchema>;
export type OpsMessage = z.infer<typeof OpsSchema>;
export type SnapshotMessage = z.infer<typeof SnapshotSchema>;
export type ErrorMessage = z.infer<typeof ErrorSchema>;

export function safeParseClientMessage(data: unknown) {
  return ClientMessageSchema.safeParse(data);
}

export function safeParseServerMessage(data: unknown) {
  return ServerMessageSchema.safeParse(data);
}
