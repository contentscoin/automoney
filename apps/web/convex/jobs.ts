import { v, type ObjectType } from "convex/values";
import { APPROVAL_TTL_MS, CHANNEL_PLATFORM, JOB_LEASE_MS, guessMediaKind, kstDayKey, validatePublishPayload, type JobType, type PublishPayload } from "@automoney/shared";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { audit } from "./lib/audit";
import { fail } from "./lib/errors";
import { requireUser } from "./lib/rbac";
import { consumePiece, hashPiecePublishSnapshot } from "./lib/pieces";
import { livePublishEnabled } from "./lib/publishPolicy";
import { marketingRedirectUrl } from "./lib/publicUrl";
import { publishReceiptUrl } from "./lib/publishReceipt";
import { publicationIdentity } from "./lib/publishIdentity";
import { internal } from "./_generated/api";
import { sha256Hex } from "./lib/crypto";
import { metaLivePublishAvailable } from "./lib/meta";

const MAX_EXECUTION_ATTEMPTS = 3;
const MAX_QUEUE_AGE_MS = 24 * 60 * 60_000;
const SWEEP_BATCH_SIZE = 100;

export const jobTypeValidator = v.union(
  v.literal("post.publish"),
  v.literal("space.create"),
  v.literal("space.login"),
  v.literal("space.verify"),
  v.literal("codex.login"),
  v.literal("content.generate"),
  v.literal("post.readback"),
  v.literal("meta.token_refresh"),
);
const sourceValidator = v.union(v.literal("WEB"), v.literal("SCHEDULE"), v.literal("TELEGRAM"), v.literal("MCP"), v.literal("SYSTEM"));

export interface EnqueueInput {
  userId: Id<"users">;
  jobType: JobType;
  payload: Record<string, unknown>;
  spaceId?: Id<"spaces">;
  scheduleId?: Id<"schedules">;
  source: "WEB" | "SCHEDULE" | "TELEGRAM" | "MCP" | "SYSTEM";
  executor?: "DESKTOP" | "CLOUD";
  fallbackFromJobId?: Id<"agentJobs">;
  needsApproval?: boolean;
  runAfter?: number;
  idempotencyKey?: string;
  requestKey?: string;
  rootJobId?: Id<"agentJobs">;
  expiresAt?: number;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`).join(",")}}`;
}

/** 플랫폼·계정·본문·미디어·링크·콘텐츠 버전을 포함한 승인 결합 해시. */
export async function hashJobPayload(jobType: JobType, payload: Record<string, unknown>): Promise<string> {
  return await sha256Hex(canonicalJson({ jobType, payload }));
}

export function validateExecutorPublishContract(space: Doc<"spaces">, payload: PublishPayload): string | null {
  if (space.authMode !== "META_API") return null;
  if (payload.mediaUrls.length > 1) return "현재 Meta API 게시 경로는 미디어 1개까지만 지원합니다.";
  if (payload.platform === "INSTAGRAM" && payload.mediaUrls.some((url) => guessMediaKind(url) === "video") && payload.contentChannel !== "INSTAGRAM_REEL")
    return "Instagram 동영상은 게시 형식을 Reel로 명시해야 합니다.";
  return null;
}

/** 공통 enqueue. 멱등키는 사용자 tenant 안에서만 유효하며 다른 payload 재사용은 충돌이다. */
export async function enqueueJob(ctx: MutationCtx, input: EnqueueInput): Promise<Id<"agentJobs">> {
  const payload = { ...input.payload };
  let publishSpace: Doc<"spaces"> | null = null;
  if (input.jobType === "post.publish") {
    if (!input.spaceId) fail("INVALID_ARGUMENT", "게시 스페이스가 필요합니다.");
    publishSpace = await ctx.db.get(input.spaceId);
    if (!publishSpace || publishSpace.userId !== input.userId) fail("NOT_FOUND", "스페이스를 찾을 수 없습니다.");
    const publishPayload = payload as unknown as PublishPayload;
    if (publishPayload.spaceId !== publishSpace._id || publishPayload.platform !== publishSpace.platform)
      fail("INVALID_ARGUMENT", "게시 대상 스페이스와 페이로드가 일치하지 않습니다.");
    const dryRun = publishPayload.dryRun === true;
    const identity = await publicationIdentity(ctx, publishSpace);
    if (!dryRun && publishSpace.sessionState !== "HEALTHY")
      fail("CONFLICT", "정상 상태로 확인된 게시 계정만 실게시 작업에 사용할 수 있습니다.");
    if (!dryRun && !identity) fail("CONFLICT", "게시 계정 식별 정보를 확인할 수 없습니다. 계정 상태를 다시 확인하세요.");
    if (!dryRun && publishSpace.authMode === "META_API" && (!identity?.account || !metaLivePublishAvailable(identity.account.mode)))
      fail("CONFIG_MISSING", "실게시에는 Graph 모드의 Meta 앱 자격증명과 실제 연결 계정이 필요합니다. Mock 연결은 테스트 실행만 가능합니다.");
    if (publishPayload.targetPublicationKey) {
      if (!identity || publishPayload.targetPublicationKey !== identity.publicationKey)
        fail("CONFLICT", "TARGET_IDENTITY_CHANGED");
    } else if (identity) {
      publishPayload.targetPublicationKey = identity.publicationKey;
    }
    if (!publishPayload.targetHandle && identity?.normalizedHandle) publishPayload.targetHandle = identity.normalizedHandle;
    if (!dryRun && !publishPayload.targetPublicationKey) fail("CONFLICT", "게시 대상 계정 snapshot이 필요합니다.");
    const err = validatePublishPayload(publishPayload);
    if (err) fail("INVALID_ARGUMENT", `발행 내용 오류: ${err}`);
    const executorError = validateExecutorPublishContract(publishSpace, publishPayload);
    if (executorError) fail("INVALID_ARGUMENT", executorError);
  }
  const requestKey = input.requestKey ?? input.idempotencyKey;
  const payloadHash = await hashJobPayload(input.jobType, payload);
  if (requestKey) {
    const dup = await ctx.db.query("agentJobs").withIndex("by_user_requestKey", (q) => q.eq("userId", input.userId).eq("requestKey", requestKey)).unique();
    if (dup) {
      if (dup.payloadHash && dup.payloadHash !== payloadHash) fail("CONFLICT", "IDEMPOTENCY_CONFLICT");
      return dup._id;
    }
  }
  const now = Date.now();
  // 실행 주체: Meta API 로 연결된 스페이스의 발행·토큰 갱신은 클라우드(Convex 액션), 나머지는 데스크톱 에이전트 (ADR-0004)
  let executor: "DESKTOP" | "CLOUD" = input.executor ?? "DESKTOP";
  if (!input.executor && input.jobType === "post.publish" && input.spaceId) {
    const space = publishSpace ?? await ctx.db.get(input.spaceId);
    if (space?.authMode === "META_API" && space.snsAccountId) {
      const acct = await ctx.db.get(space.snsAccountId);
      if (acct?.status === "ACTIVE") executor = "CLOUD";
    }
  }
  if (input.jobType === "meta.token_refresh") executor = "CLOUD";
  const status = input.needsApproval ? "NEEDS_APPROVAL" : "QUEUED";
  const id = await ctx.db.insert("agentJobs", {
    userId: input.userId,
    deviceId: input.spaceId ? publishSpace?.deviceId ?? (await ctx.db.get(input.spaceId))?.deviceId : undefined,
    spaceId: input.spaceId,
    scheduleId: input.scheduleId,
    jobType: input.jobType,
    payload,
    status,
    executor,
    fallbackFromJobId: input.fallbackFromJobId,
    runAfter: input.runAfter ?? now,
    idempotencyKey: input.idempotencyKey,
    requestKey,
    payloadHash,
    approvalRequired: input.jobType === "post.publish" ? input.needsApproval !== false : false,
    protocolVersion: 2,
    expiresAt: input.expiresAt,
    cancelRequested: false,
    source: input.source,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.patch(id, { rootJobId: input.rootJobId ?? id });
  if (executor === "CLOUD" && status === "QUEUED") await ctx.scheduler.runAfter(Math.max(0, (input.runAfter ?? now) - now), internal.meta.runCloudJob, { jobId: id });
  return id;
}

async function ownSpace(ctx: MutationCtx, userId: Id<"users">, spaceId: Id<"spaces">): Promise<Doc<"spaces">> {
  const s = await ctx.db.get(spaceId);
  if (!s || s.userId !== userId) fail("NOT_FOUND", "스페이스를 찾을 수 없습니다.");
  return s;
}

/** 유저: 즉시 발행 잡 (웹) */
const enqueuePublishArgs = {
    spaceId: v.id("spaces"),
    text: v.string(),
    mediaUrls: v.array(v.string()),
    linkId: v.optional(v.id("marketingLinks")),
    pieceId: v.optional(v.id("contentPieces")),
    contentChannel: v.optional(v.union(v.literal("INSTAGRAM_FEED"), v.literal("INSTAGRAM_REEL"), v.literal("THREADS"), v.literal("X"), v.literal("TIKTOK"), v.literal("BLOG"))),
    requireApproval: v.optional(v.boolean()),
    dryRun: v.optional(v.boolean()),
    clientRequestId: v.optional(v.string()),
  };

export async function enqueuePublishFor(ctx: MutationCtx, user: Doc<"users">, args: ObjectType<typeof enqueuePublishArgs>, source: "WEB" | "MCP" = "WEB") {
  if (args.clientRequestId !== undefined && !/^[A-Za-z0-9_-]{8,100}$/.test(args.clientRequestId))
    fail("INVALID_ARGUMENT", "게시 요청 식별자가 올바르지 않습니다.");
  const requestKey = args.clientRequestId ? `publish-request:${user._id}:${args.clientRequestId}` : undefined;
  const space = await ownSpace(ctx, user._id, args.spaceId);
  if (space.sessionState !== "HEALTHY" && source === "WEB") fail("CONFLICT", "정상 상태의 게시 계정만 사용할 수 있습니다. 연결 관리에서 로그인과 상태 확인을 완료하세요.");
  if (!(args.dryRun ?? false) && !livePublishEnabled()) fail("CONFLICT", "실게시가 운영 kill switch로 중지되어 있습니다. 테스트 실행을 사용하세요.");
  if (!(args.dryRun ?? false) && space.authMode === "META_API") {
    const account = space.snsAccountId ? await ctx.db.get(space.snsAccountId) : null;
    if (!account || !metaLivePublishAvailable(account.mode)) fail("CONFIG_MISSING", "실게시에는 Graph 모드의 Meta 앱 자격증명과 실제 연결 계정이 필요합니다. Mock 연결은 테스트 실행만 가능합니다.");
  }
  let text = args.text;
  let mediaUrls = args.mediaUrls;
  let contentProductId: Id<"products"> | undefined;
  let contentChannel: PublishPayload["contentChannel"] = args.contentChannel;
  let workflowPiece: Awaited<ReturnType<typeof consumePiece>> | null = null;
  if (args.pieceId) {
    const piece = await consumePiece(ctx, user._id, args.pieceId);
    if (args.contentChannel && args.contentChannel !== piece.channel) fail("CONFLICT", "명시한 게시 형식과 콘텐츠 채널이 일치하지 않습니다.");
    if (CHANNEL_PLATFORM[piece.channel as keyof typeof CHANNEL_PLATFORM] !== space.platform) fail("INVALID_ARGUMENT", "콘텐츠 채널과 게시 계정 플랫폼이 일치하지 않습니다.");
    contentProductId = piece.productId;
    contentChannel = piece.channel as PublishPayload["contentChannel"];
    if (text.trim() && text.trim() !== piece.text.trim()) fail("CONFLICT", "콘텐츠 본문은 승인된 revision과 같아야 합니다. 콘텐츠를 편집한 뒤 다시 승인하세요.");
    if (mediaUrls.length > 0 && JSON.stringify(mediaUrls) !== JSON.stringify(piece.mediaUrls)) fail("CONFLICT", "콘텐츠 미디어는 승인된 revision과 같아야 합니다.");
    text = piece.text;
    mediaUrls = piece.mediaUrls;
    workflowPiece = piece;
  }
  if (contentChannel && CHANNEL_PLATFORM[contentChannel] !== space.platform) fail("INVALID_ARGUMENT", "게시 형식과 게시 계정 플랫폼이 일치하지 않습니다.");
  let linkUrl: string | null = null;
  if (args.linkId) {
    const link = await ctx.db.get(args.linkId);
    if (!link || link.userId !== user._id) fail("NOT_FOUND", "링크를 찾을 수 없습니다.");
    if (link.status !== "ACTIVE") fail("CONFLICT", "활성 상태의 링크만 게시에 사용할 수 있습니다.");
    if (contentProductId && link.productId !== contentProductId) fail("INVALID_ARGUMENT", "콘텐츠 상품과 마케팅 링크 상품이 일치하지 않습니다.");
    linkUrl = marketingRedirectUrl(link.shortCode);
    if (!linkUrl) fail("CONFIG_MISSING", "SITE_URL은 공개 HTTPS 주소로 설정해야 합니다.");
  }
  if (workflowPiece?.productId && !args.linkId) fail("INVALID_ARGUMENT", "제작 워크플로 콘텐츠에는 같은 상품의 활성 마케팅 링크가 필요합니다.");
  const payload: PublishPayload = {
    spaceId: space._id,
    platform: space.platform,
    ...(contentChannel ? { contentChannel } : {}),
    text,
    mediaUrls,
    linkUrl,
    dryRun: args.dryRun ?? false,
    ...(args.linkId ? { linkId: args.linkId } : {}),
    ...(args.pieceId ? { pieceId: args.pieceId } : {}),
  };
  if (workflowPiece && args.pieceId) {
    payload.pieceOutputHash = workflowPiece.outputHash;
    payload.pieceSnapshotHash = await hashPiecePublishSnapshot({
      pieceId: args.pieceId,
      outputHash: workflowPiece.outputHash,
      text,
      mediaUrls,
      linkId: args.linkId,
      linkUrl,
    });
  }
  const id = await enqueueJob(ctx, { userId: user._id, jobType: "post.publish", payload: payload as unknown as Record<string, unknown>, spaceId: space._id, source, needsApproval: args.requireApproval ?? true, requestKey });
  await audit(ctx, { actorUserId: user._id, action: "job.enqueuePublish", metadata: { jobId: id, spaceId: space._id, pieceId: args.pieceId ?? null } });
  return id;
}

export const enqueuePublish = mutation({
  args: enqueuePublishArgs,
  handler: async (ctx, args) => {
    // A browser/devtools caller cannot waive the final human gate. Trusted
    // no-approval paths (MCP confirmation hash and schedule auto-approve) call
    // their server-side helpers directly after their own stronger checks.
    return await enqueuePublishFor(ctx, await requireUser(ctx), {
      ...args,
      requireApproval: args.dryRun === true ? args.requireApproval : true,
    });
  },
});

const listMineArgs = { limit: v.optional(v.number()) };

export async function listJobsFor(ctx: QueryCtx, user: Doc<"users">, args: ObjectType<typeof listMineArgs>) {
  const rows = await ctx.db.query("agentJobs").withIndex("by_user", (q) => q.eq("userId", user._id)).order("desc").take(Math.min(args.limit ?? 50, 200));
  const out = [];
  for (const j of rows) {
    const space = j.spaceId ? await ctx.db.get(j.spaceId) : null;
    out.push({
      _id: j._id,
      jobType: j.jobType,
      status: j.status,
      stage: j.stage ?? null,
      progress: j.progress ?? null,
      source: j.source,
      spaceName: space?.name ?? null,
      spaceHandle: j.jobType === "post.publish" && typeof j.payload?.targetHandle === "string" ? j.payload.targetHandle : space?.handle ?? null,
      platform: space?.platform ?? null,
      preview: typeof j.payload?.text === "string" ? String(j.payload.text).slice(0, 80) : null,
      publishReview: j.jobType === "post.publish"
        ? {
            text: typeof j.payload?.text === "string" ? j.payload.text : "",
            mediaUrls: Array.isArray(j.payload?.mediaUrls) ? j.payload.mediaUrls.filter((url: unknown): url is string => typeof url === "string") : [],
            contentChannel: typeof j.payload?.contentChannel === "string" ? j.payload.contentChannel : null,
            linkUrl: typeof j.payload?.linkUrl === "string" ? j.payload.linkUrl : null,
            dryRun: j.payload?.dryRun === true,
            payloadHash: j.payloadHash ?? null,
          }
        : null,
      contentProduct: j.jobType === "content.generate" && Array.isArray(j.payload?.products)
        ? {
            attrangsProductId: Number(j.payload.products[0]?.attrangsProductId ?? 0) || null,
            name: typeof j.payload.products[0]?.name === "string" ? j.payload.products[0].name : null,
          }
        : null,
      errorCode: j.errorCode ?? null,
      errorMessage: j.errorMessage ?? null,
      publishPhase: j.publishPhase ?? null,
      manualPublishResolution: j.manualPublishResolution ?? null,
      result: j.result ?? null,
      runAfter: j.runAfter,
      createdAt: j.createdAt,
      finishedAt: j.finishedAt ?? null,
    });
  }
  return out;
}

export const listMine = query({
  args: listMineArgs,
  handler: async (ctx, args) => {
    return await listJobsFor(ctx, await requireUser(ctx), args);
  },
});

export const approve = mutation({
  args: { jobId: v.id("agentJobs") },
  handler: async (ctx, args) => {
    await approveJobFor(ctx, await requireUser(ctx), args.jobId, "web");
  },
});

export async function approveJobFor(
  ctx: MutationCtx,
  user: Doc<"users">,
  jobId: Id<"agentJobs">,
  via: "web" | "telegram",
): Promise<void> {
    if ((user.status ?? "ACTIVE") !== "ACTIVE") fail("FORBIDDEN", "정지된 계정입니다.");
    const j = await ctx.db.get(jobId);
    if (!j || j.userId !== user._id) fail("NOT_FOUND", "작업을 찾을 수 없습니다.");
    if (j.status !== "NEEDS_APPROVAL") fail("CONFLICT", "승인 대기 상태가 아닙니다.");
    if (j.jobType === "post.publish" && j.spaceId) {
      const space = await ctx.db.get(j.spaceId);
      if (!space || space.userId !== user._id || space.sessionState !== "HEALTHY") fail("CONFLICT", "정상 상태의 게시 계정만 승인할 수 있습니다. 연결 관리에서 로그인과 상태 확인을 완료하세요.");
      const payload = j.payload as PublishPayload;
      if (payload.dryRun !== true) {
        const identity = await publicationIdentity(ctx, space);
        if (!payload.targetPublicationKey || !identity || payload.targetPublicationKey !== identity.publicationKey)
          fail("CONFLICT", "게시 대상 계정이 등록 이후 변경되었습니다. 새 게시 작업을 등록하세요.");
      }
    }
    const payloadHash = await hashJobPayload(j.jobType, j.payload as Record<string, unknown>);
    if (j.payloadHash && j.payloadHash !== payloadHash) fail("CONFLICT", "승인할 내용이 변경되었습니다. 다시 등록하세요.");
    const now = Date.now();
    await ctx.db.patch(j._id, { status: "QUEUED", runAfter: now, payloadHash, approval: { actorUserId: user._id, approvedAt: now, payloadHash }, updatedAt: now });
    if (j.executor === "CLOUD") await ctx.scheduler.runAfter(0, internal.meta.runCloudJob, { jobId: j._id });
    await audit(ctx, { actorUserId: user._id, action: "job.approve", metadata: { jobId: j._id, via } });
}

const cancelArgs = { jobId: v.id("agentJobs") };

export async function cancelJobFor(ctx: MutationCtx, user: Doc<"users">, args: ObjectType<typeof cancelArgs>) {
  const j = await ctx.db.get(args.jobId);
  if (!j || j.userId !== user._id) fail("NOT_FOUND", "작업을 찾을 수 없습니다.");
  const now = Date.now();
  const rootJobId = j.rootJobId ?? j._id;
  const descendants = await ctx.db
    .query("agentJobs")
    .withIndex("by_rootJobId", (q) => q.eq("rootJobId", rootJobId))
    .collect();
  const family = descendants.some((candidate) => candidate._id === j._id) ? descendants : [j, ...descendants];
  let cancelled = 0;
  let cancellationRequested = 0;
  for (const member of family) {
    if (member.userId !== user._id) continue;
    if (member.status === "QUEUED" || member.status === "NEEDS_APPROVAL") {
      await ctx.db.patch(member._id, {
        status: "CANCELLED",
        cancelRequested: true,
        finishedAt: now,
        updatedAt: now,
        errorCode: "JOB_CANCELLED",
        errorMessage: "원 게시 작업 계열이 사용자 요청으로 취소되었습니다.",
      });
      cancelled++;
    } else if (member.status === "RUNNING" && !member.cancelRequested) {
      await ctx.db.patch(member._id, { cancelRequested: true, updatedAt: now });
      cancellationRequested++;
    }
  }
  if (cancelled === 0 && cancellationRequested === 0) fail("CONFLICT", "이미 종료된 작업입니다.");
  const root = await ctx.db.get(rootJobId);
  if (root && root.userId === user._id && !root.cancelRequested) await ctx.db.patch(root._id, { cancelRequested: true, updatedAt: now });
  return { cancelled, cancellationRequested };
}

export const cancel = mutation({
  args: cancelArgs,
  handler: async (ctx, args) => {
    return await cancelJobFor(ctx, await requireUser(ctx), args);
  },
});

export const releaseNotPublishedReservation = internalMutation({
  args: { reservationId: v.id("publishReservations"), jobId: v.id("agentJobs") },
  handler: async (ctx, args) => {
    const now = Date.now();
    const reservation = await ctx.db.get(args.reservationId);
    const job = await ctx.db.get(args.jobId);
    if (
      !reservation
      || reservation.rootJobId !== (job?.rootJobId ?? job?._id)
      || reservation.state !== "UNCERTAIN"
      || reservation.expiresAt > now
      || job?.manualPublishResolution?.outcome !== "NOT_PUBLISHED"
    ) return false;
    await ctx.db.patch(reservation._id, { state: "RELEASED", committedAt: undefined });
    return true;
  },
});

/** Owner reconciliation for a terminal publish whose external result was unknown. */
export const resolveUncertainPublish = mutation({
  args: {
    jobId: v.id("agentJobs"),
    outcome: v.union(v.literal("PUBLISHED"), v.literal("NOT_PUBLISHED")),
    evidenceUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const job = await ctx.db.get(args.jobId);
    if (!job || job.userId !== user._id || job.jobType !== "post.publish") fail("NOT_FOUND", "게시 작업을 찾을 수 없습니다.");
    if (job.status !== "FAILED" || job.publishPhase !== "UNCERTAIN" || job.manualPublishResolution)
      fail("CONFLICT", "결과 미확인 상태의 게시 작업만 조정할 수 있습니다.");
    const payload = job.payload as PublishPayload;
    const space = job.spaceId ? await ctx.db.get(job.spaceId) : null;
    const evidenceUrl = args.evidenceUrl?.trim();
    if (args.outcome === "PUBLISHED" && !publishReceiptUrl(payload.platform, { data: { postUrl: evidenceUrl } }, job.publishExecutionHandle ?? payload.targetHandle))
      fail("INVALID_ARGUMENT", "게시된 SNS의 올바른 게시물 HTTPS URL을 입력하세요.");
    let reservation = await ctx.db
      .query("publishReservations")
      .withIndex("by_root", (q) => q.eq("rootJobId", job.rootJobId ?? job._id))
      .unique();
    if (reservation?.state === "COMMITTED") fail("CONFLICT", "이미 게시 완료로 확정된 작업입니다.");
    const resolvedAt = Date.now();
    const releaseAt = args.outcome === "NOT_PUBLISHED" && reservation
      ? Math.max(reservation.expiresAt, resolvedAt + 15 * 60_000)
      : undefined;
    if (!reservation && args.outcome === "PUBLISHED") {
      if (!space) fail("CONFLICT", "게시 계정 정보를 찾을 수 없습니다.");
      if (!payload.targetPublicationKey) fail("CONFLICT", "원 게시 대상 계정 snapshot이 없어 자동 조정할 수 없습니다.");
      const reservationId = await ctx.db.insert("publishReservations", {
        userId: job.userId,
        spaceId: space._id,
        publicationKey: payload.targetPublicationKey,
        rootJobId: job.rootJobId ?? job._id,
        kstDay: kstDayKey(resolvedAt),
        state: "COMMITTED",
        reservedAt: resolvedAt,
        expiresAt: resolvedAt,
        committedAt: resolvedAt,
      });
      reservation = (await ctx.db.get(reservationId))!;
    }
    const resolvedResult = args.outcome === "PUBLISHED"
      ? {
          schema: "automoney.job-result/v1" as const,
          jobType: "post.publish" as const,
          kind: "ok" as const,
          summary: "사용자가 SNS에서 게시 완료를 수동 확인했습니다.",
          data: { postUrl: evidenceUrl!, dryRun: false, manuallyReconciled: true },
          warnings: ["자동 실행 결과는 불명확했으며 사용자가 게시물 URL로 조정했습니다."],
          errorCode: null,
        }
      : job.result;
    if (reservation) await ctx.db.patch(reservation._id, args.outcome === "PUBLISHED"
      ? { state: "COMMITTED", committedAt: resolvedAt }
      : { state: "UNCERTAIN", expiresAt: releaseAt!, committedAt: undefined });
    await ctx.db.patch(job._id, {
      publishPhase: args.outcome === "PUBLISHED" ? "CONFIRMED" : "NOT_PUBLISHED",
      manualPublishResolution: {
        outcome: args.outcome,
        actorUserId: user._id,
        resolvedAt,
        ...(evidenceUrl ? { evidenceUrl } : {}),
        ...(releaseAt ? { releaseAt } : {}),
      },
      result: resolvedResult,
      updatedAt: resolvedAt,
    });
    if (args.outcome === "PUBLISHED") {
      await ctx.scheduler.runAfter(0, internal.analytics.recordResolvedPublish, { jobId: job._id });
    } else if (reservation && releaseAt) {
      await ctx.scheduler.runAt(releaseAt, internal.jobs.releaseNotPublishedReservation, { reservationId: reservation._id, jobId: job._id });
    }
    await audit(ctx, {
      actorUserId: user._id,
      action: "job.resolveUncertainPublish",
      metadata: { jobId: job._id, reservationId: reservation?._id ?? null, outcome: args.outcome, evidenceUrl: evidenceUrl ?? null },
    });
    return { outcome: args.outcome, resolvedAt, releaseAt: releaseAt ?? null };
  },
});

/** 크론(1분): 만료 lease/queue/승인을 유한 batch로 종결한다. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const running = await ctx.db
      .query("agentJobs")
      .withIndex("by_status_lease", (q) => q.eq("status", "RUNNING").lte("leaseUntil", now))
      .take(SWEEP_BATCH_SIZE);
    let requeued = 0;
    let lost = 0;
    let exhausted = 0;
    for (const j of running) {
      if (j.jobType === "post.publish") {
        const reservation = await ctx.db.query("publishReservations").withIndex("by_root", (q) => q.eq("rootJobId", j.rootJobId ?? j._id)).unique();
        const payload = j.payload as PublishPayload;
        const resultMayBeExternal = payload.dryRun !== true
          && j.publishPhase === "INTENT_RECORDED"
          && reservation?.state === "RESERVED";
        await ctx.db.patch(j._id, {
          status: "FAILED",
          publishPhase: resultMayBeExternal ? "UNCERTAIN" : "PREPARING",
          errorCode: resultMayBeExternal ? "AGENT_LOST_UNCERTAIN" : "AGENT_LOST_BEFORE_PUBLISH",
          errorMessage: resultMayBeExternal
            ? "게시 승인 이후 에이전트 응답이 끊겨 실제 게시 여부를 확인할 수 없습니다."
            : "외부 게시 승인 전에 에이전트 응답이 종료되어 게시하지 않았습니다.",
          finishedAt: now,
          updatedAt: now,
        });
        if (reservation) await ctx.db.patch(reservation._id, { state: resultMayBeExternal ? "UNCERTAIN" : "RELEASED" });
        lost++;
      } else if ((j.attemptNo ?? 0) >= MAX_EXECUTION_ATTEMPTS || now - j.createdAt >= MAX_QUEUE_AGE_MS) {
        await ctx.db.patch(j._id, {
          status: "FAILED",
          errorCode: "EXECUTION_RETRY_EXHAUSTED",
          errorMessage: `실행 재시도 ${MAX_EXECUTION_ATTEMPTS}회 또는 최대 대기 시간을 초과했습니다. 원인을 확인한 뒤 새 작업으로 다시 요청하세요.`,
          finishedAt: now,
          updatedAt: now,
        });
        if (j.jobType === "content.generate") await ctx.scheduler.runAfter(0, internal.content.refreshRunForJob, { jobId: j._id });
        exhausted++;
      } else {
        await ctx.db.patch(j._id, { status: "QUEUED", claimedByDeviceId: undefined, leaseUntil: undefined, stage: "requeued:lease_expired", updatedAt: now });
        requeued++;
      }
      if (j.spaceId) {
        const s = await ctx.db.get(j.spaceId);
        if (s?.lockJobId === j._id) await ctx.db.patch(s._id, { lockJobId: undefined, sessionState: s.sessionState === "RUNNING" ? "HEALTHY" : s.sessionState });
      }
    }
    const staleQueued = await ctx.db
      .query("agentJobs")
      .withIndex("by_status_created", (q) => q.eq("status", "QUEUED").lte("createdAt", now - MAX_QUEUE_AGE_MS))
      .take(SWEEP_BATCH_SIZE);
    let timedOut = 0;
    for (const j of staleQueued) {
      await ctx.db.patch(j._id, {
        status: "FAILED",
        errorCode: "DEVICE_OFFLINE_TIMEOUT",
        errorMessage: "24시간 동안 실행 가능한 에이전트를 찾지 못했습니다. 앱 연결 상태를 확인한 뒤 새 작업으로 다시 요청하세요.",
        finishedAt: now,
        updatedAt: now,
      });
      if (j.jobType === "content.generate") await ctx.scheduler.runAfter(0, internal.content.refreshRunForJob, { jobId: j._id });
      timedOut++;
    }
    const pending = await ctx.db
      .query("agentJobs")
      .withIndex("by_status_created", (q) => q.eq("status", "NEEDS_APPROVAL").lte("createdAt", now - APPROVAL_TTL_MS))
      .take(SWEEP_BATCH_SIZE);
    let expired = 0;
    for (const j of pending) {
      await ctx.db.patch(j._id, { status: "CANCELLED", errorCode: "JOB_CANCELLED", errorMessage: "승인 시한(24시간) 초과", finishedAt: now, updatedAt: now });
      expired++;
    }
    return { requeued, lost, exhausted, timedOut, expired };
  },
});

/** 텔레그램 등 내부 호출용 */
export const enqueueInternal = internalMutation({
  args: { userId: v.id("users"), jobType: jobTypeValidator, payload: v.any(), spaceId: v.optional(v.id("spaces")), source: sourceValidator, needsApproval: v.optional(v.boolean()), idempotencyKey: v.optional(v.string()), requestKey: v.optional(v.string()) },
  handler: async (ctx, args) => enqueueJob(ctx, { ...args, payload: args.payload as Record<string, unknown> }),
});

export const finalizeFromSchedule = internalMutation({
  args: { jobId: v.id("agentJobs") },
  handler: async (ctx, args) => {
    const j = await ctx.db.get(args.jobId);
    if (!j) return;
    await ctx.scheduler.runAfter(0, internal.telegram.notifyJob, { jobId: j._id });
  },
});

export const JOB_LEASE = JOB_LEASE_MS;
