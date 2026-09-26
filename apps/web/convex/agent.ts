import { v } from "convex/values";
import { APPROVAL_TTL_MS, CHANNEL_PLATFORM, JOB_LEASE_MS, kstDayKey, validatePublishPayload, type JobType, type PublishPayload } from "@automoney/shared";
import { internal } from "./_generated/api";
import { ingestGeneratedJob, MIN_CONTENT_DESKTOP_VERSION, versionAtLeast } from "./content";
import { ingestReadbackJob, recordPublishedPost } from "./analytics";
import type { Doc, Id } from "./_generated/dataModel";
import { httpAction, internalMutation, internalQuery, type ActionCtx } from "./_generated/server";
import { sha256Hex } from "./lib/crypto";
import { canonicalJson } from "./jobs";
import { contentPieceEvidenceRunId, contentPieceHasOperatorSupplyLineage, contentPieceProductAvailable, contentPiecePublishOutputHash, contentPieceText, hashPiecePublishSnapshot, operatorSupplySourceAvailable, workflowReviewEvidence } from "./lib/pieces";
import { livePublishEnabled, PUBLISH_PROTOCOL_VERSION } from "./lib/publishPolicy";
import { marketingRedirectUrl } from "./lib/publicUrl";
import { publishReceiptUrl } from "./lib/publishReceipt";
import { publicationIdentity } from "./lib/publishIdentity";
import { validatePublishAttemptPolicy } from "./lib/publishAttempt";
import { metaLivePublishAvailable } from "./lib/meta";
import { isActiveSuperAdmin } from "./lib/rbac";

/** 데스크톱 에이전트 HTTP 계약 (blogautomcp remote-agent 계승). 인증: Authorization: Bearer <deviceToken>. */

export const MIN_PUBLISH_DESKTOP_VERSION = "0.1.13";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
const err = (code: string, message: string, status: number) => json({ success: false, error: { code, message } }, status);

async function authDevice(ctx: { runQuery: (ref: typeof internal.devices.authenticate, args: { tokenHash: string }) => Promise<{ deviceId: Id<"devices">; userId: Id<"users"> } | null> }, request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!/^[A-Z2-9]{43}$/.test(token)) return null;
  return await ctx.runQuery(internal.devices.authenticate, { tokenHash: await sha256Hex(token) });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const t = await request.text();
    if (t.length > 512_000) return null;
    const v = t ? JSON.parse(t) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const claim = httpAction(async (ctx, request) => {
  const dev = await authDevice(ctx, request);
  if (!dev) return err("UNAUTHENTICATED", "invalid device token", 401);
  const body = (await readJson(request)) ?? {};
  const job = await ctx.runMutation(internal.agent.claimJob, {
    deviceId: dev.deviceId,
    userId: dev.userId,
    appVersion: typeof body.appVersion === "string" ? body.appVersion : undefined,
    snapshot: body.status ?? undefined,
  });
  return json({ success: true, data: job });
});

async function handleHeartbeat(ctx: ActionCtx, request: Request): Promise<Response> {
  const dev = await authDevice(ctx, request);
  if (!dev) return err("UNAUTHENTICATED", "invalid device token", 401);
  const url = new URL(request.url);
  const jobId = url.pathname.split("/").filter(Boolean).at(-2) as Id<"agentJobs"> | undefined;
  if (!jobId) return err("INVALID_ARGUMENT", "job id missing", 400);
  const body = (await readJson(request)) ?? {};
  const r = await ctx.runMutation(internal.agent.heartbeatJob, {
    jobId,
    deviceId: dev.deviceId,
    attemptNo: typeof body.attemptNo === "number" ? body.attemptNo : undefined,
    leaseTokenHash: typeof body.leaseToken === "string" ? await sha256Hex(body.leaseToken) : undefined,
    stage: typeof body.stage === "string" ? body.stage.slice(0, 80) : undefined,
    progress: typeof body.progress === "number" ? body.progress : undefined,
  });
  return json({ success: true, data: r });
}

async function handleComplete(ctx: ActionCtx, request: Request): Promise<Response> {
  const dev = await authDevice(ctx, request);
  if (!dev) return err("UNAUTHENTICATED", "invalid device token", 401);
  const url = new URL(request.url);
  const jobId = url.pathname.split("/").filter(Boolean).at(-2) as Id<"agentJobs"> | undefined;
  if (!jobId) return err("INVALID_ARGUMENT", "job id missing", 400);
  const body = await readJson(request);
  if (!body || (body.status !== "SUCCEEDED" && body.status !== "FAILED")) return err("INVALID_ARGUMENT", "status must be SUCCEEDED|FAILED", 400);
  const completionInput = { status: body.status, result: body.result, errorCode: body.errorCode, errorMessage: body.errorMessage, spaceUpdate: body.spaceUpdate };
  const r = await ctx.runMutation(internal.agent.completeJob, {
    jobId,
    deviceId: dev.deviceId,
    status: body.status,
    result: body.result,
    errorCode: typeof body.errorCode === "string" ? body.errorCode.slice(0, 60) : undefined,
    errorMessage: typeof body.errorMessage === "string" ? body.errorMessage.slice(0, 1000) : undefined,
    spaceUpdate: body.spaceUpdate,
    attemptNo: typeof body.attemptNo === "number" ? body.attemptNo : undefined,
    leaseTokenHash: typeof body.leaseToken === "string" ? await sha256Hex(body.leaseToken) : undefined,
    completionId: typeof body.completionId === "string" ? body.completionId.slice(0, 100) : undefined,
    completionHash: await sha256Hex(canonicalJson(completionInput)),
  });
  if (!r.ok) return err("CONFLICT", r.reason ?? "job not active", 409);
  return json({ success: true, data: r });
}

async function handlePreflight(ctx: ActionCtx, request: Request): Promise<Response> {
  const dev = await authDevice(ctx, request);
  if (!dev) return err("UNAUTHENTICATED", "invalid device token", 401);
  const url = new URL(request.url);
  const jobId = url.pathname.split("/").filter(Boolean).at(-2) as Id<"agentJobs"> | undefined;
  if (!jobId) return err("INVALID_ARGUMENT", "job id missing", 400);
  const body = (await readJson(request)) ?? {};
  const result = await ctx.runMutation(internal.agent.preflightJob, {
    jobId,
    deviceId: dev.deviceId,
    attemptNo: typeof body.attemptNo === "number" ? body.attemptNo : undefined,
    leaseTokenHash: typeof body.leaseToken === "string" ? await sha256Hex(body.leaseToken) : undefined,
  });
  if (!result.ok) return json({
    success: false,
    error: { code: result.reason, message: result.message },
    data: { protocolVersion: result.protocolVersion, livePublishEnabled: result.livePublishEnabled },
  }, 409);
  return json({ success: true, data: result });
}

async function handlePublishAttempt(ctx: ActionCtx, request: Request): Promise<Response> {
  const dev = await authDevice(ctx, request);
  if (!dev) return err("UNAUTHENTICATED", "invalid device token", 401);
  const url = new URL(request.url);
  const jobId = url.pathname.split("/").filter(Boolean).at(-2) as Id<"agentJobs"> | undefined;
  if (!jobId) return err("INVALID_ARGUMENT", "job id missing", 400);
  const body = (await readJson(request)) ?? {};
  const recorded = await ctx.runMutation(internal.agent.markDesktopPublishAttempted, {
    jobId,
    deviceId: dev.deviceId,
    attemptNo: typeof body.attemptNo === "number" ? body.attemptNo : undefined,
    leaseTokenHash: typeof body.leaseToken === "string" ? await sha256Hex(body.leaseToken) : undefined,
  });
  if (!recorded) return err("CONFLICT", "publish attempt is not authorized", 409);
  return json({ success: true, data: { recorded: true } });
}

async function handlePublishContinuation(ctx: ActionCtx, request: Request): Promise<Response> {
  const dev = await authDevice(ctx, request);
  if (!dev) return err("UNAUTHENTICATED", "invalid device token", 401);
  const url = new URL(request.url);
  const jobId = url.pathname.split("/").filter(Boolean).at(-2) as Id<"agentJobs"> | undefined;
  if (!jobId) return err("INVALID_ARGUMENT", "job id missing", 400);
  const body = (await readJson(request)) ?? {};
  const result = await ctx.runMutation(internal.agent.revalidateDesktopPublishContinuation, {
    jobId,
    deviceId: dev.deviceId,
    attemptNo: typeof body.attemptNo === "number" ? body.attemptNo : undefined,
    leaseTokenHash: typeof body.leaseToken === "string" ? await sha256Hex(body.leaseToken) : undefined,
  });
  if (!result.ok) return err(result.reason, "publish continuation is not authorized", 409);
  return json({ success: true, data: { authorized: true } });
}

/** /agent/jobs/:id/heartbeat | /agent/jobs/:id/complete */
export const jobsRouter = httpAction(async (ctx, request) => {
  const path = new URL(request.url).pathname;
  if (path.endsWith("/heartbeat")) return handleHeartbeat(ctx, request);
  if (path.endsWith("/preflight")) return handlePreflight(ctx, request);
  if (path.endsWith("/publish-attempt")) return handlePublishAttempt(ctx, request);
  if (path.endsWith("/publish-continuation")) return handlePublishContinuation(ctx, request);
  if (path.endsWith("/complete")) return handleComplete(ctx, request);
  return err("NOT_FOUND", "unknown agent route", 404);
});

/** 에이전트가 로컬 스페이스 상태(세션 검증 결과 등)를 보고 */
export const spacesSync = httpAction(async (ctx, request) => {
  const dev = await authDevice(ctx, request);
  if (!dev) return err("UNAUTHENTICATED", "invalid device token", 401);
  const body = await readJson(request);
  const updates = Array.isArray(body?.spaces) ? (body!.spaces as unknown[]) : [];
  const r = await ctx.runMutation(internal.agent.syncSpaces, { deviceId: dev.deviceId, updates });
  return json({ success: true, data: r });
});

export const config = httpAction(async (ctx, request) => {
  const dev = await authDevice(ctx, request);
  if (!dev) return err("UNAUTHENTICATED", "invalid device token", 401);
  const data = await ctx.runQuery(internal.agent.deviceConfig, { deviceId: dev.deviceId });
  return json({ success: true, data });
});

// ─────────────────────────────── internal ───────────────────────────────

export const claimJob = internalMutation({
  args: { deviceId: v.id("devices"), userId: v.id("users"), appVersion: v.optional(v.string()), snapshot: v.optional(v.any()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.patch(args.deviceId, { lastSeenAt: now, ...(args.appVersion ? { appVersion: args.appVersion } : {}), ...(args.snapshot !== undefined ? { snapshot: args.snapshot } : {}) });
    const device = await ctx.db.get(args.deviceId);
    const appVersion = args.appVersion ?? device?.appVersion ?? "0.0.0";
    const claimableTypes: JobType[] = ["space.create", "space.login", "space.verify", "codex.login", "post.readback"];
    if (versionAtLeast(appVersion, MIN_CONTENT_DESKTOP_VERSION)) claimableTypes.push("content.generate");
    if (versionAtLeast(appVersion, MIN_PUBLISH_DESKTOP_VERSION)) claimableTypes.push("post.publish");
    const routedCandidates = [];
    for (const jobType of claimableTypes) {
      for (const routedDeviceId of [args.deviceId, undefined]) {
        routedCandidates.push(...await ctx.db
          .query("agentJobs")
          .withIndex("by_user_device_executor_status_type", (q) => q
            .eq("userId", args.userId)
            .eq("deviceId", routedDeviceId)
            .eq("executor", "DESKTOP")
            .eq("status", "QUEUED")
            .eq("jobType", jobType)
            .lte("runAfter", now))
          .order("asc")
          .take(20));
      }
    }
    const candidates = routedCandidates
      .filter((job, index, rows) => rows.findIndex((candidate) => candidate._id === job._id) === index)
      .sort((a, b) => a.runAfter - b.runAfter || a.createdAt - b.createdAt);
    for (const j of candidates) {
      if (j.executor === "CLOUD") continue;
      if (j.spaceId) {
        const s = await ctx.db.get(j.spaceId);
        if (!s) {
          await ctx.db.patch(j._id, { status: "FAILED", errorCode: "SPACE_NOT_FOUND", errorMessage: "스페이스가 삭제되었습니다.", finishedAt: now, updatedAt: now });
          continue;
        }
        if (s.lockJobId && s.lockJobId !== j._id) continue; // 다른 잡이 스페이스 사용 중
        if (s.deviceId !== args.deviceId) {
          // Backfill the routing key for jobs created before device-bound
          // queue indexes existed, then continue without starving unbound jobs.
          if (j.deviceId !== s.deviceId) await ctx.db.patch(j._id, { deviceId: s.deviceId, updatedAt: now });
          continue;
        }
        await ctx.db.patch(s._id, { lockJobId: j._id, sessionState: s.sessionState === "HEALTHY" ? "RUNNING" : s.sessionState });
      }
      const attemptNo = (j.attemptNo ?? 0) + 1;
      const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
      const leaseToken = Array.from(tokenBytes, (b) => b.toString(16).padStart(2, "0")).join("");
      const leaseTokenHash = await sha256Hex(leaseToken);
      await ctx.db.patch(j._id, {
        status: "RUNNING",
        claimedByDeviceId: args.deviceId,
        leaseUntil: now + JOB_LEASE_MS,
        heartbeatAt: now,
        stage: "claimed",
        attemptNo,
        leaseTokenHash,
        protocolVersion: PUBLISH_PROTOCOL_VERSION,
        ...(j.jobType === "post.publish" ? {
          publishPhase: "PREPARING" as const,
          publishPreflightAttemptNo: undefined,
          publishPreflightPayloadHash: undefined,
          publishPreflightAt: undefined,
          publishIntentId: undefined,
        } : {}),
        updatedAt: now,
      });
      const space = j.spaceId ? await ctx.db.get(j.spaceId) : null;
      return { id: j._id, jobType: j.jobType, payload: j.payload, spaceId: j.spaceId ?? null, space: space ? { _id: space._id, platform: space.platform, name: space.name, handle: space.handle ?? null, pinned: space.pinned } : null, leaseMs: JOB_LEASE_MS, protocolVersion: PUBLISH_PROTOCOL_VERSION, attemptNo, leaseToken, leaseExpiresAt: now + JOB_LEASE_MS };
    }
    return null;
  },
});

export const heartbeatJob = internalMutation({
  args: { jobId: v.id("agentJobs"), deviceId: v.id("devices"), attemptNo: v.optional(v.number()), leaseTokenHash: v.optional(v.string()), stage: v.optional(v.string()), progress: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.patch(args.deviceId, { lastSeenAt: now });
    const j = await ctx.db.get(args.jobId);
    if (!j || j.status !== "RUNNING" || j.claimedByDeviceId !== args.deviceId) return { active: false, cancelRequested: false };
    if (j.jobType === "post.publish" && (args.attemptNo === undefined || !args.leaseTokenHash)) return { active: false, cancelRequested: false, staleAttempt: true };
    if (args.attemptNo !== undefined && (args.attemptNo !== j.attemptNo || args.leaseTokenHash !== j.leaseTokenHash)) return { active: false, cancelRequested: false, staleAttempt: true };
    await ctx.db.patch(j._id, { leaseUntil: now + JOB_LEASE_MS, heartbeatAt: now, stage: args.stage ?? j.stage, progress: args.progress ?? j.progress, updatedAt: now });
    return { active: true, cancelRequested: j.cancelRequested };
  },
});

export const preflightJob = internalMutation({
  args: { jobId: v.id("agentJobs"), deviceId: v.optional(v.id("devices")), attemptNo: v.optional(v.number()), leaseTokenHash: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const j = await ctx.db.get(args.jobId);
    const capability = { protocolVersion: PUBLISH_PROTOCOL_VERSION, livePublishEnabled: livePublishEnabled() };
    const deny = (reason: string, message: string) => ({ ok: false as const, reason, message, ...capability });
    if (!j || j.jobType !== "post.publish" || j.status !== "RUNNING") return deny("JOB_NOT_ACTIVE", "발행 작업이 실행 상태가 아닙니다.");
    if (args.deviceId && j.claimedByDeviceId !== args.deviceId) return deny("STALE_ATTEMPT", "다른 실행 주체가 소유한 작업입니다.");
    if (args.deviceId && (args.attemptNo === undefined || !args.leaseTokenHash)) return deny("LEASE_PROOF_REQUIRED", "attemptNo와 leaseToken이 필요합니다.");
    if (args.deviceId && (args.attemptNo !== j.attemptNo || args.leaseTokenHash !== j.leaseTokenHash)) return deny("STALE_ATTEMPT", "만료된 실행 시도입니다.");
    if ((j.leaseUntil ?? 0) < now) return deny("LEASE_EXPIRED", "작업 lease가 만료되었습니다.");
    if (j.publishAttemptedAt) return deny("PUBLISH_ALREADY_ATTEMPTED", "이미 게시 동작이 전송된 작업입니다. 결과를 확인하기 전 다시 실행할 수 없습니다.");
    // 동일 attempt가 사전검증을 다시 요청하면 이전 허가는 먼저 폐기한다. 이후 검증이
    // 실패해도 과거 marker로 성공 completion을 제출할 수 없어야 한다.
    await ctx.db.patch(j._id, {
      publishPhase: "PREPARING",
      publishPreflightAttemptNo: undefined,
      publishPreflightPayloadHash: undefined,
      publishPreflightAt: undefined,
      publishIntentId: undefined,
      publishExecutionHandle: undefined,
      updatedAt: now,
    });
    if (j.cancelRequested) return deny("JOB_CANCELLED", "취소된 작업입니다.");
    const rootJob = j.rootJobId && j.rootJobId !== j._id ? await ctx.db.get(j.rootJobId) : j;
    if (rootJob?.cancelRequested || rootJob?.status === "CANCELLED")
      return deny("JOB_CANCELLED", "원 게시 작업 계열이 취소되었습니다.");
    if (j.expiresAt && j.expiresAt < now) return deny("SCHEDULE_EXPIRED", "예약 실행 허용 시간이 지났습니다.");
    const user = await ctx.db.get(j.userId);
    if (!user || (user.status ?? "ACTIVE") !== "ACTIVE") return deny("USER_SUSPENDED", "사용자 계정이 활성 상태가 아닙니다.");
    const space = j.spaceId ? await ctx.db.get(j.spaceId) : null;
    if (!space || space.userId !== j.userId) return deny("SPACE_NOT_FOUND", "스페이스를 찾을 수 없습니다.");
    if (!["HEALTHY", "RUNNING"].includes(space.sessionState)) return deny("SPACE_NOT_READY", "스페이스가 게시 가능한 상태가 아닙니다.");
    const payload = j.payload as PublishPayload;
    if (payload.spaceId !== space._id || payload.platform !== space.platform)
      return deny("PUBLISH_TARGET_MISMATCH", "작업의 게시 대상과 잠긴 스페이스가 일치하지 않습니다.");
    const targetIdentity = await publicationIdentity(ctx, space);
    if (payload.dryRun !== true) {
      if (!payload.targetPublicationKey) return deny("TARGET_IDENTITY_REVIEW_REQUIRED", "기존 작업에 게시 대상 계정 snapshot이 없습니다. 새 작업을 등록하세요.");
      if (!targetIdentity) return deny("SPACE_IDENTITY_UNVERIFIED", "게시 계정 식별 정보를 다시 확인하세요.");
      if (payload.targetPublicationKey !== targetIdentity.publicationKey)
        return deny("TARGET_IDENTITY_CHANGED", "승인 후 게시 계정이 변경되었습니다. 새 작업을 등록하고 다시 승인하세요.");
      if (space.authMode === "META_API" && (!targetIdentity.account || !metaLivePublishAvailable(targetIdentity.account.mode)))
        return deny("META_CONFIG", "Mock Meta 연결 또는 누락된 앱 자격증명으로는 실게시할 수 없습니다.");
    }
    if (j.scheduleId) {
      const schedule = await ctx.db.get(j.scheduleId);
      const consumedOneShot = schedule?.kind === "ONE_SHOT"
        && schedule.lastJobId === (j.rootJobId ?? j._id)
        && schedule.lastRunAt !== undefined;
      if (!schedule || (!schedule.enabled && !consumedOneShot) || payload.scheduleRevision === undefined || schedule.revision !== payload.scheduleRevision)
        return deny("SCHEDULE_REVISION_CHANGED", "예약이 생성 이후 변경되거나 삭제되었습니다. 현재 예약에서 새 실행을 기다리세요.");
    }
    const piece = payload.pieceId ? await ctx.db.get(payload.pieceId as Id<"contentPieces">) : null;
    if (payload.pieceId && (!piece || piece.status !== "APPROVED")) return deny("CONTENT_UNAVAILABLE", "승인된 콘텐츠를 찾을 수 없습니다.");
    if (piece) {
      if (!(await operatorSupplySourceAvailable(ctx, piece))) return deny("CONTENT_UNAVAILABLE", "운영 콘텐츠 공개가 종료되었습니다.");
      if (!(await contentPieceProductAvailable(ctx, piece))) return deny("CONTENT_PRODUCT_INACTIVE", "연결된 상품이 현재 판매 중이 아닙니다.");
      const accessible = piece.ownerUserId === j.userId || piece.visibility === "SHARED" || isActiveSuperAdmin(user);
      if (!accessible) return deny("CONTENT_UNAVAILABLE", "승인된 콘텐츠에 더 이상 접근할 수 없습니다.");
      if (payload.contentChannel && payload.contentChannel !== piece.channel)
        return deny("CONTENT_CHANNEL_MISMATCH", "작업의 콘텐츠 채널이 승인된 콘텐츠와 일치하지 않습니다.");
    }
    const pieceEvidenceRunId = piece ? contentPieceEvidenceRunId(piece) : undefined;
    if (piece && !pieceEvidenceRunId && piece.generatedBy !== "manual")
      return deny("CONTENT_REVIEW_REQUIRED", "이전 품질 계약으로 생성된 콘텐츠는 게시할 수 없습니다. 새 제작 워크플로로 다시 생성하세요.");
    if (piece && pieceEvidenceRunId) {
      const run = await ctx.db.get(pieceEvidenceRunId);
      const standardPassed = (piece.productionMeta as { standardPassed?: boolean } | undefined)?.standardPassed === true;
      if (!standardPassed || (!contentPieceHasOperatorSupplyLineage(piece) && run?.status !== "COMPLETED"))
        return deny("CONTENT_REVIEW_REQUIRED", "전체 제작 실행의 품질 검수와 사람 승인이 완료되지 않았습니다.");
      const review = await workflowReviewEvidence(ctx, piece);
      if (!review.ok) return deny("CONTENT_REVIEW_REQUIRED", review.reason);
    }
    if (piece && CHANNEL_PLATFORM[piece.channel as keyof typeof CHANNEL_PLATFORM] !== space.platform) return deny("CONTENT_PLATFORM_MISMATCH", "콘텐츠 채널과 게시 계정 플랫폼이 일치하지 않습니다.");
    const link = payload.linkId ? await ctx.db.get(payload.linkId as Id<"marketingLinks">) : null;
    if (payload.linkId && (!link || link.userId !== j.userId)) return deny("LINK_NOT_FOUND", "마케팅 링크를 찾을 수 없습니다.");
    if (link?.status !== undefined && link.status !== "ACTIVE") return deny("LINK_INACTIVE", "비활성 마케팅 링크는 게시할 수 없습니다.");
    if (piece?.productId && link && piece.productId !== link.productId) return deny("CONTENT_LINK_PRODUCT_MISMATCH", "콘텐츠 상품과 마케팅 링크 상품이 일치하지 않습니다.");
    const expectedLinkUrl = link ? marketingRedirectUrl(link.shortCode) : null;
    if (link && !expectedLinkUrl) return deny("PUBLIC_SITE_URL_INVALID", "SITE_URL은 공개 HTTPS 주소로 설정해야 합니다.");
    if (link && payload.linkUrl !== expectedLinkUrl) return deny("LINK_URL_MISMATCH", "게시 링크가 현재 공개 마케팅 링크와 일치하지 않습니다.");
    if (!link && payload.linkUrl) return deny("LINK_REFERENCE_REQUIRED", "게시 링크의 소유권을 확인할 수 없습니다.");
    const payloadError = validatePublishPayload({
      ...payload,
      spaceId: space._id,
      platform: space.platform,
      ...(piece ? { contentChannel: piece.channel as PublishPayload["contentChannel"] } : {}),
    });
    if (payloadError) return deny("PUBLISH_PAYLOAD_INVALID", `발행 내용 오류: ${payloadError}`);
    if (piece) {
      if (pieceEvidenceRunId && piece.productId && !link) return deny("CONTENT_LINK_REQUIRED", "제작 워크플로 콘텐츠에는 승인된 상품 링크가 필요합니다.");
      const outputHash = await contentPiecePublishOutputHash(piece);
      if (!outputHash || !payload.pieceOutputHash || !payload.pieceSnapshotHash)
        return deny("CONTENT_SNAPSHOT_MISSING", "승인된 콘텐츠 revision 정보가 없습니다. 다시 게시 작업을 만드세요.");
      const canonicalText = contentPieceText(piece);
      const snapshotHash = await hashPiecePublishSnapshot({
        pieceId: piece._id,
        outputHash,
        text: canonicalText,
        mediaUrls: piece.mediaUrls,
        linkId: link?._id,
        linkUrl: expectedLinkUrl,
      });
      if (
        payload.pieceOutputHash !== outputHash
        || payload.pieceSnapshotHash !== snapshotHash
        || payload.text !== canonicalText
        || JSON.stringify(payload.mediaUrls) !== JSON.stringify(piece.mediaUrls)
        || payload.linkUrl !== expectedLinkUrl
      ) return deny("CONTENT_REVISION_CHANGED", "발행 내용이 승인된 콘텐츠 revision과 일치하지 않습니다.");
    }
    const currentHash = await sha256Hex(canonicalJson({ jobType: j.jobType, payload: j.payload }));
    if (!j.payloadHash || currentHash !== j.payloadHash) return deny("STALE_APPROVAL", "발행 내용이 변경되었습니다.");
    if (j.approvalRequired !== false) {
      if (!j.approval || j.approval.payloadHash !== currentHash) return deny("APPROVAL_REQUIRED", "현재 발행 내용의 승인이 필요합니다.");
      if (now - j.approval.approvedAt > APPROVAL_TTL_MS) return deny("APPROVAL_EXPIRED", "발행 승인이 만료되었습니다.");
    }
    if (payload.dryRun) {
      await ctx.db.patch(j._id, {
        publishPhase: "INTENT_RECORDED",
        publishPreflightAttemptNo: j.attemptNo,
        publishPreflightPayloadHash: currentHash,
        publishPreflightAt: now,
        publishIntentId: undefined,
        publishExecutionHandle: targetIdentity?.normalizedHandle ?? undefined,
        updatedAt: now,
      });
      return { ok: true as const, dryRun: true, publishIntentId: null, ...capability };
    }
    if (!capability.livePublishEnabled) return deny("LIVE_PUBLISH_DISABLED", "실게시가 운영 kill switch로 중지되어 있습니다.");
    const rootJobId = j.rootJobId ?? j._id;
    const existing = await ctx.db.query("publishReservations").withIndex("by_root", (q) => q.eq("rootJobId", rootJobId)).unique();
    if (existing && (existing.state === "COMMITTED" || existing.state === "UNCERTAIN")) {
      return deny(existing.state === "COMMITTED" ? "ALREADY_PUBLISHED" : "PUBLISH_RESULT_UNCERTAIN", "이 실행 계열의 게시 결과를 수동 확인해야 합니다.");
    }

    // Serialize every irreversible publish for one real account. A Meta API
    // space and its browser fallback are separate space rows but the same
    // external publishing identity, so they must share the mutex and quota.
    const identitySpaceIds = new Set<Id<"spaces">>([space._id]);
    const identity = targetIdentity!;
    const publicationKey = identity.publicationKey;
    const linkedAccount = identity.account;
    if (linkedAccount) {
      if (linkedAccount.spaceId) identitySpaceIds.add(linkedAccount.spaceId);
      if (linkedAccount.fallbackSpaceId) identitySpaceIds.add(linkedAccount.fallbackSpaceId);
    }
    if (identity.normalizedHandle) {
      const aliases = await ctx.db.query("spaces").withIndex("by_user", (q) => q.eq("userId", j.userId)).collect();
      for (const alias of aliases) {
        const aliasHandle = alias.handle?.trim().replace(/^@/, "").toLowerCase();
        if (alias.platform === space.platform && aliasHandle === identity.normalizedHandle) identitySpaceIds.add(alias._id);
      }
    }
    let identityDailyLimit = space.dailyPostLimit;
    for (const identitySpaceId of identitySpaceIds) {
      const identitySpace = identitySpaceId === space._id ? space : await ctx.db.get(identitySpaceId);
      if (identitySpace?.userId === j.userId && identitySpace.platform === space.platform) {
        identityDailyLimit = Math.min(identityDailyLimit, identitySpace.dailyPostLimit);
      }
    }
    const day = kstDayKey(now);
    // Date-independent fallback for reservations created before
    // publicationKey existed. Never infer that a legacy unresolved intent
    // belongs to a newly logged-in account; conservatively require resolution.
    for (const identitySpaceId of identitySpaceIds) {
      const legacyUncertain = await ctx.db.query("publishReservations")
        .withIndex("by_space_state", (q) => q.eq("spaceId", identitySpaceId).eq("state", "UNCERTAIN"))
        .collect();
      if (legacyUncertain.some((reservation) => !reservation.publicationKey && reservation.rootJobId !== rootJobId))
        return deny("PUBLISH_RESULT_UNCERTAIN", "이 스페이스에 이전 버전의 결과 미확인 작업이 있습니다. 먼저 수동 조정하세요.");
      const legacyReserved = await ctx.db.query("publishReservations")
        .withIndex("by_space_state", (q) => q.eq("spaceId", identitySpaceId).eq("state", "RESERVED"))
        .collect();
      if (legacyReserved.some((reservation) => !reservation.publicationKey && reservation.rootJobId !== rootJobId))
        return deny("PUBLISH_IN_PROGRESS", "이 스페이스에 이전 버전의 진행 중 게시 작업이 있습니다.");
    }
    // UNCERTAIN and in-flight intents are account locks, not daily quota rows:
    // they survive a KST date boundary until the owner explicitly reconciles
    // the external result.
    const unresolvedAcrossDays = await ctx.db
      .query("publishReservations")
      .withIndex("by_publication_state", (q) => q.eq("publicationKey", publicationKey).eq("state", "UNCERTAIN"))
      .collect();
    if (unresolvedAcrossDays.some((reservation) => reservation.rootJobId !== rootJobId))
      return deny("PUBLISH_RESULT_UNCERTAIN", "같은 게시 계정에 결과 미확인 작업이 있습니다. SNS에서 먼저 확인하세요.");
    const reservedAcrossDays = await ctx.db
      .query("publishReservations")
      .withIndex("by_publication_state", (q) => q.eq("publicationKey", publicationKey).eq("state", "RESERVED"))
      .collect();
    if (reservedAcrossDays.some((reservation) => reservation.rootJobId !== rootJobId))
      return deny("PUBLISH_IN_PROGRESS", "같은 게시 계정에서 다른 게시 작업이 진행 중입니다.");
    const reservationMap = new Map<string, Doc<"publishReservations">>();
    for (const reservation of await ctx.db
      .query("publishReservations")
      .withIndex("by_publication_day", (q) => q.eq("publicationKey", publicationKey).eq("kstDay", day))
      .collect()) reservationMap.set(reservation._id, reservation);
    // Include rows created before publicationKey existed and rows on the
    // sibling Meta/fallback space during a rolling deployment.
    for (const identitySpaceId of identitySpaceIds) {
      for (const reservation of await ctx.db
        .query("publishReservations")
        .withIndex("by_space_day", (q) => q.eq("spaceId", identitySpaceId).eq("kstDay", day))
        .collect()) reservationMap.set(reservation._id, reservation);
    }
    if (existing) reservationMap.set(existing._id, existing);
    const reservations = [...reservationMap.values()];
    const conflictingIntent = reservations.find((reservation) =>
      reservation.rootJobId !== rootJobId
      && (reservation.state === "RESERVED" || reservation.state === "UNCERTAIN"),
    );
    if (conflictingIntent) {
      return deny(
        conflictingIntent.state === "UNCERTAIN" ? "PUBLISH_RESULT_UNCERTAIN" : "PUBLISH_IN_PROGRESS",
        conflictingIntent.state === "UNCERTAIN"
          ? "같은 게시 계정에 결과 미확인 작업이 있습니다. SNS에서 먼저 확인하세요."
          : "같은 게시 계정에서 다른 게시 작업이 진행 중입니다.",
      );
    }
    const active = reservations.filter((r) => r.rootJobId !== rootJobId && r.state !== "RELEASED");
    if (active.length >= identityDailyLimit) return deny("DAILY_LIMIT", "오늘의 게시 한도에 도달했습니다.");
    const intervalCutoff = now - 15 * 60_000;
    const recentMap = new Map(active.map((reservation) => [reservation._id, reservation]));
    for (const reservation of await ctx.db
      .query("publishReservations")
      .withIndex("by_publication_state_committed", (q) => q
        .eq("publicationKey", publicationKey)
        .eq("state", "COMMITTED")
        .gt("committedAt", intervalCutoff))
      .collect()) recentMap.set(reservation._id, reservation);
    const intervalStartDay = kstDayKey(intervalCutoff);
    if (intervalStartDay !== day) {
      // Rolling-upgrade compatibility for reservations created before
      // publicationKey was introduced.
      for (const identitySpaceId of identitySpaceIds) {
        for (const reservation of await ctx.db
          .query("publishReservations")
          .withIndex("by_space_day", (q) => q.eq("spaceId", identitySpaceId).eq("kstDay", intervalStartDay))
          .collect()) recentMap.set(reservation._id, reservation);
      }
    }
    const recent = [...recentMap.values()].filter((r) => r.rootJobId !== rootJobId && r.state === "COMMITTED" && (r.committedAt ?? 0) > intervalCutoff);
    if (recent.length > 0) return deny("MIN_INTERVAL", "최근 게시 후 15분이 지나지 않았습니다.");
    if (existing?.state === "RESERVED") {
      await ctx.db.patch(existing._id, { publicationKey, spaceId: space._id, kstDay: day, reservedAt: now, expiresAt: now + 2 * 60 * 60_000 });
      await ctx.db.patch(j._id, {
        publishPhase: "INTENT_RECORDED",
        publishPreflightAttemptNo: j.attemptNo,
        publishPreflightPayloadHash: currentHash,
        publishPreflightAt: now,
        publishIntentId: existing._id,
        publishExecutionHandle: identity.normalizedHandle ?? undefined,
        updatedAt: now,
      });
      return { ok: true as const, dryRun: false, publishIntentId: existing._id, ...capability };
    }
    const publishIntentId = existing
      ? (await ctx.db.patch(existing._id, { userId: j.userId, spaceId: space._id, publicationKey, kstDay: day, state: "RESERVED", reservedAt: now, expiresAt: now + 2 * 60 * 60_000, committedAt: undefined }), existing._id)
      : await ctx.db.insert("publishReservations", { userId: j.userId, spaceId: space._id, publicationKey, rootJobId, kstDay: day, state: "RESERVED", reservedAt: now, expiresAt: now + 2 * 60 * 60_000 });
    await ctx.db.patch(j._id, {
      publishPhase: "INTENT_RECORDED",
      publishPreflightAttemptNo: j.attemptNo,
      publishPreflightPayloadHash: currentHash,
      publishPreflightAt: now,
      publishIntentId,
      publishExecutionHandle: identity.normalizedHandle ?? undefined,
      updatedAt: now,
    });
    return { ok: true as const, dryRun: false, publishIntentId, ...capability };
  },
});

export const markDesktopPublishAttempted = internalMutation({
  args: {
    jobId: v.id("agentJobs"),
    deviceId: v.id("devices"),
    attemptNo: v.optional(v.number()),
    leaseTokenHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const job = await ctx.db.get(args.jobId);
    if (!job || job.jobType !== "post.publish" || job.status !== "RUNNING" || job.claimedByDeviceId !== args.deviceId) return false;
    if (args.attemptNo === undefined || !args.leaseTokenHash || args.attemptNo !== job.attemptNo || args.leaseTokenHash !== job.leaseTokenHash) return false;
    if ((job.leaseUntil ?? 0) < now) return false;
    const policy = await validatePublishAttemptPolicy(ctx, job, now);
    if (!policy.ok) return false;
    await ctx.db.patch(job._id, { publishAttemptedAt: now, stage: "browser_publish_attempted", updatedAt: now });
    return true;
  },
});

/**
 * Revalidates a second step in the same irreversible provider interaction
 * (currently Naver's publish confirmation) without creating a new intent or
 * permitting another top-level publish attempt.
 */
export const revalidateDesktopPublishContinuation = internalMutation({
  args: {
    jobId: v.id("agentJobs"),
    deviceId: v.id("devices"),
    attemptNo: v.optional(v.number()),
    leaseTokenHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const job = await ctx.db.get(args.jobId);
    if (!job || job.jobType !== "post.publish" || job.status !== "RUNNING" || job.claimedByDeviceId !== args.deviceId)
      return { ok: false as const, reason: "JOB_NOT_ACTIVE" };
    if (args.attemptNo === undefined || !args.leaseTokenHash || args.attemptNo !== job.attemptNo || args.leaseTokenHash !== job.leaseTokenHash)
      return { ok: false as const, reason: "STALE_ATTEMPT" };
    if ((job.leaseUntil ?? 0) < now) return { ok: false as const, reason: "LEASE_EXPIRED" };
    const policy = await validatePublishAttemptPolicy(ctx, job, now, { continuation: true });
    if (!policy.ok) return policy;
    await ctx.db.patch(job._id, { stage: "browser_publish_continuation_authorized", updatedAt: now });
    return { ok: true as const };
  },
});

export const completeJob = internalMutation({
  args: {
    jobId: v.id("agentJobs"),
    deviceId: v.id("devices"),
    status: v.union(v.literal("SUCCEEDED"), v.literal("FAILED")),
    result: v.optional(v.any()),
    errorCode: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    spaceUpdate: v.optional(v.any()),
    attemptNo: v.optional(v.number()),
    leaseTokenHash: v.optional(v.string()),
    completionId: v.optional(v.string()),
    completionHash: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const j = await ctx.db.get(args.jobId);
    if (j && args.completionId && j.completionId === args.completionId) {
      if (j.jobType === "post.publish" && j.claimedByDeviceId !== args.deviceId)
        return { ok: false as const, reason: "STALE_ATTEMPT" };
      return j.completionHash === args.completionHash ? { ok: true as const, duplicate: true as const } : { ok: false as const, reason: "COMPLETION_CONFLICT" };
    }
    if (!j || j.status !== "RUNNING" || j.claimedByDeviceId !== args.deviceId) return { ok: false as const, reason: "JOB_NOT_ACTIVE" };
    if (j.jobType === "post.publish" && (args.attemptNo === undefined || !args.leaseTokenHash)) return { ok: false as const, reason: "LEASE_PROOF_REQUIRED" };
    if (args.attemptNo !== undefined && (args.attemptNo !== j.attemptNo || args.leaseTokenHash !== j.leaseTokenHash)) return { ok: false as const, reason: "STALE_ATTEMPT" };
    if (j.jobType === "post.publish" && (j.leaseUntil ?? 0) < now) return { ok: false as const, reason: "LEASE_EXPIRED" };
    if (j.jobType === "post.publish" && args.status === "SUCCEEDED") {
      const currentHash = await sha256Hex(canonicalJson({ jobType: j.jobType, payload: j.payload }));
      const payload = j.payload as PublishPayload;
      if (
        j.publishPhase !== "INTENT_RECORDED"
        || j.publishPreflightAttemptNo !== j.attemptNo
        || j.publishPreflightAttemptNo !== args.attemptNo
        || j.publishPreflightPayloadHash !== currentHash
      ) return { ok: false as const, reason: "PREFLIGHT_REQUIRED" };
      if (!payload.dryRun) {
        if (!j.publishIntentId) return { ok: false as const, reason: "PUBLISH_INTENT_REQUIRED" };
        const intent = await ctx.db.get(j.publishIntentId);
        if (!intent || intent.rootJobId !== (j.rootJobId ?? j._id) || intent.state !== "RESERVED" || intent.expiresAt < now)
          return { ok: false as const, reason: "PUBLISH_INTENT_INVALID" };
      }
    }
    const publishPayload = j.jobType === "post.publish" ? j.payload as PublishPayload : null;
    const attemptMarkerMissing = publishPayload !== null
      && args.status === "SUCCEEDED"
      && publishPayload.dryRun !== true
      && !j.publishAttemptedAt;
    const receiptMissing = publishPayload !== null
      && args.status === "SUCCEEDED"
      && publishPayload.dryRun !== true
      && !publishReceiptUrl(publishPayload.platform, args.result, j.publishExecutionHandle ?? publishPayload.targetHandle);
    let effectiveStatus = receiptMissing || attemptMarkerMissing ? "FAILED" as const : args.status;
    let effectiveErrorCode = attemptMarkerMissing ? "PUBLISH_ATTEMPT_MISSING" : receiptMissing ? "PUBLISH_RECEIPT_MISSING" : args.errorCode;
    let effectiveErrorMessage = attemptMarkerMissing
      ? "게시 시도 직전 서버 승인 기록이 없어 성공 결과를 확정할 수 없습니다. SNS에서 직접 확인하세요."
      : receiptMissing
        ? "실게시 성공을 증명하는 새 게시물 URL이 없어 결과를 확정할 수 없습니다. SNS에서 직접 확인하세요."
        : args.errorMessage;
    const cancellationAfterIntent = publishPayload?.dryRun !== true
      && j.publishPhase === "INTENT_RECORDED"
      && j.cancelRequested
      && effectiveErrorCode === "JOB_CANCELLED";
    if (cancellationAfterIntent) {
      effectiveStatus = "FAILED";
      effectiveErrorCode = "PUBLISH_RESULT_UNCERTAIN";
      effectiveErrorMessage = "게시 승인 이후 취소 신호가 도착해 실제 게시 여부를 확인할 수 없습니다. SNS에서 직접 확인하세요.";
    }
    const cancelled = j.cancelRequested && effectiveErrorCode === "JOB_CANCELLED";
    const postIntentFailure = publishPayload?.dryRun !== true
      && args.status === "FAILED"
      && j.publishPhase === "INTENT_RECORDED";
    const attemptedFailure = postIntentFailure && !!j.publishAttemptedAt;
    if (attemptedFailure) {
      effectiveErrorCode = "PUBLISH_RESULT_UNCERTAIN";
      effectiveErrorMessage = "게시 동작을 전송한 뒤 결과를 확인하지 못했습니다. 자동 재게시하지 않으니 SNS에서 직접 확인하세요.";
    } else if (postIntentFailure && !cancellationAfterIntent) {
      // Fail closed even for a stale/out-of-contract client that omits the
      // publish-attempt marker after receiving an irreversible intent.
      effectiveErrorCode = "PUBLISH_RESULT_UNCERTAIN";
      effectiveErrorMessage = "게시 직전 승인 이후 실행이 종료되어 실제 게시 여부를 확정할 수 없습니다. SNS에서 직접 확인하세요.";
    }
    const publishUncertain = receiptMissing || attemptMarkerMissing || cancellationAfterIntent || postIntentFailure || (effectiveStatus === "FAILED" && ["AGENT_LOST_UNCERTAIN", "META_PUBLISH_TIMEOUT", "PUBLISH_RESULT_UNCERTAIN"].includes(effectiveErrorCode ?? ""));
    await ctx.db.patch(j._id, {
      status: cancelled ? "CANCELLED" : effectiveStatus,
      result: args.result,
      errorCode: effectiveStatus === "FAILED" ? effectiveErrorCode ?? "INTERNAL" : undefined,
      errorMessage: effectiveStatus === "FAILED" ? effectiveErrorMessage : undefined,
      finishedAt: now,
      updatedAt: now,
      stage: "done",
      progress: 100,
      completionId: args.completionId,
      completionHash: args.completionId ? args.completionHash : undefined,
      ...(j.jobType === "post.publish" ? { publishPhase: effectiveStatus === "SUCCEEDED" ? "CONFIRMED" as const : publishUncertain ? "UNCERTAIN" as const : "PREPARING" as const } : {}),
    });
    if (j.jobType === "post.publish") {
      const rootJobId = j.rootJobId ?? j._id;
      const reservation = await ctx.db.query("publishReservations").withIndex("by_root", (q) => q.eq("rootJobId", rootJobId)).unique();
      if (reservation) {
        await ctx.db.patch(reservation._id, effectiveStatus === "SUCCEEDED" ? { state: "COMMITTED", committedAt: now } : publishUncertain ? { state: "UNCERTAIN" } : { state: "RELEASED" });
      }
    }
    if (j.spaceId) {
      const s = await ctx.db.get(j.spaceId);
      if (s) {
        const upd = (args.spaceUpdate ?? {}) as { sessionState?: string; handle?: string; fingerprint?: unknown; lastError?: string };
        const allowed = ["CREATED", "LOGIN_REQUIRED", "HEALTHY", "EXPIRED", "RESTRICTED"];
        const nextState = upd.sessionState && allowed.includes(upd.sessionState) ? (upd.sessionState as typeof s.sessionState) : s.sessionState === "RUNNING" ? "HEALTHY" : s.sessionState;
        await ctx.db.patch(s._id, {
          lockJobId: s.lockJobId === j._id ? undefined : s.lockJobId,
          sessionState: nextState,
          lastCheckedAt: now,
          ...(typeof upd.handle === "string" ? { handle: upd.handle.replace(/^@/, "").slice(0, 60) } : {}),
          ...(upd.fingerprint !== undefined ? { fingerprint: upd.fingerprint } : {}),
          lastError: effectiveStatus === "FAILED" ? (effectiveErrorMessage ?? effectiveErrorCode ?? "").slice(0, 300) : undefined,
        });
      }
    }
    if (j.jobType === "content.generate") await ingestGeneratedJob(ctx, j._id);
    if (effectiveStatus === "SUCCEEDED" && !cancelled) {
      const done = (await ctx.db.get(j._id))!;
      if (j.jobType === "post.publish") await recordPublishedPost(ctx, done);
      if (j.jobType === "post.readback") await ingestReadbackJob(ctx, done);
    }
    await ctx.scheduler.runAfter(0, internal.telegram.notifyJob, { jobId: j._id });
    return { ok: true as const, ...((receiptMissing || attemptMarkerMissing) ? { receiptUncertain: true as const } : {}) };
  },
});

export const syncSpaces = internalMutation({
  args: { deviceId: v.id("devices"), updates: v.array(v.any()) },
  handler: async (ctx, args) => {
    let applied = 0;
    const allowed = new Set(["CREATED", "LOGIN_REQUIRED", "HEALTHY", "EXPIRED", "RESTRICTED"]);
    for (const u of args.updates as { spaceId?: string; sessionState?: string; handle?: string }[]) {
      if (!u.spaceId) continue;
      const s = await ctx.db.get(u.spaceId as Id<"spaces">);
      if (!s || s.deviceId !== args.deviceId) continue;
      if (s.lockJobId) continue;
      await ctx.db.patch(s._id, {
        ...(u.sessionState && allowed.has(u.sessionState) ? { sessionState: u.sessionState as typeof s.sessionState } : {}),
        ...(typeof u.handle === "string" ? { handle: u.handle.replace(/^@/, "").slice(0, 60) } : {}),
        lastCheckedAt: Date.now(),
      });
      applied++;
    }
    await ctx.db.patch(args.deviceId, { lastSeenAt: Date.now() });
    return { applied };
  },
});

export const deviceConfig = internalQuery({
  args: { deviceId: v.id("devices") },
  handler: async (ctx, args) => {
    const d = await ctx.db.get(args.deviceId);
    if (!d) return null;
    const user = await ctx.db.get(d.userId);
    const spaces = await ctx.db.query("spaces").withIndex("by_device", (q) => q.eq("deviceId", d._id)).collect();
    return {
      deviceId: d._id,
      userEmail: user?.email ?? "",
      minAppVersion: (() => {
        const configured = process.env.MIN_DESKTOP_VERSION;
        return configured && versionAtLeast(configured, MIN_PUBLISH_DESKTOP_VERSION) ? configured : MIN_PUBLISH_DESKTOP_VERSION;
      })(),
      protocolVersion: PUBLISH_PROTOCOL_VERSION,
      capabilities: { livePublish: livePublishEnabled(), publishPreflightRequired: true },
      spaces: spaces.map((s) => ({ _id: s._id, platform: s.platform, name: s.name, handle: s.handle ?? null, pinned: s.pinned, sessionState: s.sessionState })),
    };
  },
});
