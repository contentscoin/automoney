import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import { generateCode, normalizeCode, PAIR_CODE_TTL_MS, type PublishPayload } from "@automoney/shared";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { audit } from "./lib/audit";
import { sha256Hex } from "./lib/crypto";
import { fail } from "./lib/errors";
import { requireUser } from "./lib/rbac";
import { enqueueJob } from "./jobs";

const PAIR_CODE_LENGTH = 8;

async function stopJobsOwnedByDevice(
  ctx: MutationCtx,
  userId: Doc<"users">["_id"],
  deviceId: Doc<"devices">["_id"],
  reason: "device_replaced" | "device_revoked",
  now: number,
) {
  const running = await ctx.db.query("agentJobs").withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", "RUNNING")).collect();
  for (const job of running) {
    if (job.claimedByDeviceId !== deviceId) continue;
    if (job.jobType === "post.publish") {
      const reservation = await ctx.db.query("publishReservations").withIndex("by_root", (q) => q.eq("rootJobId", job.rootJobId ?? job._id)).unique();
      const payload = job.payload as PublishPayload;
      const resultMayBeExternal = payload.dryRun !== true
        && job.publishPhase === "INTENT_RECORDED"
        && reservation?.state === "RESERVED";
      await ctx.db.patch(job._id, {
        status: "FAILED",
        publishPhase: resultMayBeExternal ? "UNCERTAIN" : "PREPARING",
        errorCode: resultMayBeExternal ? "AGENT_LOST_UNCERTAIN" : "AGENT_LOST_BEFORE_PUBLISH",
        errorMessage: resultMayBeExternal
          ? (reason === "device_replaced"
              ? "게시 승인 이후 디바이스가 교체되었습니다. 실제 게시 여부를 확인하세요."
              : "게시 승인 이후 디바이스 연결이 해제되었습니다. 실제 게시 여부를 확인하세요.")
          : "외부 게시 승인 전에 디바이스 연결이 종료되어 게시하지 않았습니다.",
        stage: `${resultMayBeExternal ? "uncertain" : "failed"}:${reason}`,
        finishedAt: now,
        updatedAt: now,
      });
      if (reservation && reservation.state !== "COMMITTED") await ctx.db.patch(reservation._id, { state: resultMayBeExternal ? "UNCERTAIN" : "RELEASED" });
    } else if (job.spaceId) {
      await ctx.db.patch(job._id, {
        status: "FAILED",
        errorCode: reason === "device_replaced" ? "DEVICE_REPLACED_BEFORE_RUN" : "DEVICE_REVOKED_BEFORE_RUN",
        errorMessage: "이 작업의 브라우저 프로필을 보유한 디바이스 연결이 종료되었습니다. 새 스페이스에서 다시 요청하세요.",
        stage: `failed:${reason}`,
        finishedAt: now,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(job._id, {
        status: "QUEUED",
        deviceId: undefined,
        claimedByDeviceId: undefined,
        leaseUntil: undefined,
        leaseTokenHash: undefined,
        stage: `requeued:${reason}`,
        updatedAt: now,
      });
    }
    if (job.spaceId) {
      const space = await ctx.db.get(job.spaceId);
      if (space?.lockJobId === job._id) {
        await ctx.db.patch(space._id, {
          lockJobId: undefined,
          sessionState: space.sessionState === "RUNNING" ? "HEALTHY" : space.sessionState,
        });
      }
    }
  }
  const spaces = await ctx.db.query("spaces").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).collect();
  for (const space of spaces) {
    await ctx.db.patch(space._id, { sessionState: "PAUSED", lockJobId: undefined, lastError: "연결된 디바이스가 교체되거나 해제되었습니다." });
    const jobs = await ctx.db.query("agentJobs").withIndex("by_space", (q) => q.eq("spaceId", space._id)).collect();
    for (const job of jobs) {
      if (job.status !== "QUEUED" && job.status !== "NEEDS_APPROVAL") continue;
      await ctx.db.patch(job._id, {
        status: "FAILED",
        errorCode: reason === "device_replaced" ? "DEVICE_REPLACED_BEFORE_RUN" : "DEVICE_REVOKED_BEFORE_RUN",
        errorMessage: "이 작업의 브라우저 프로필을 보유한 디바이스 연결이 종료되었습니다. 새 스페이스에서 다시 요청하세요.",
        stage: `failed:${reason}`,
        finishedAt: now,
        updatedAt: now,
      });
    }
  }
}

/** 유저: 페어링 코드 발급 (10분 유효, 1회용). 코드는 해시만 저장. */
export const createPairCode = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const old = await ctx.db.query("pairCodes").withIndex("by_user", (q) => q.eq("userId", user._id)).collect();
    for (const o of old) if (!o.usedAt) await ctx.db.delete(o._id);
    const code = generateCode(PAIR_CODE_LENGTH);
    await ctx.db.insert("pairCodes", { userId: user._id, codeHash: await sha256Hex(code), expiresAt: Date.now() + PAIR_CODE_TTL_MS });
    return { code, expiresAt: Date.now() + PAIR_CODE_TTL_MS, deepLink: `automoney://pair?code=${code}` };
  },
});

/**
 * 데스크톱: 코드로 페어링 → 디바이스 토큰 발급 (토큰은 1회만 반환, 해시만 저장).
 * 1유저 1활성 디바이스: 기존 디바이스는 REPLACED, 그 디바이스의 RUNNING 잡은 재큐잉.
 */
export const pair = mutation({
  args: { code: v.string(), deviceName: v.string(), platform: v.string(), appVersion: v.string() },
  handler: async (ctx, args) => {
    const code = normalizeCode(args.code);
    if (code.length !== PAIR_CODE_LENGTH) fail("INVALID_ARGUMENT", "페어링 코드 형식이 올바르지 않습니다.");
    const codeHash = await sha256Hex(code);
    const pc = await ctx.db.query("pairCodes").withIndex("by_codeHash", (q) => q.eq("codeHash", codeHash)).unique();
    const now = Date.now();
    if (!pc || pc.usedAt || pc.expiresAt < now) fail("INVALID_ARGUMENT", "페어링 코드가 만료되었거나 유효하지 않습니다.");
    await ctx.db.patch(pc._id, { usedAt: now });

    const actives = await ctx.db.query("devices").withIndex("by_user", (q) => q.eq("userId", pc.userId).eq("status", "ACTIVE")).collect();
    for (const d of actives) {
      await ctx.db.patch(d._id, { status: "REPLACED" });
      await stopJobsOwnedByDevice(ctx, pc.userId, d._id, "device_replaced", now);
    }
    const rawToken = `${generateCode(20)}${generateCode(23)}`;
    const deviceId = await ctx.db.insert("devices", {
      userId: pc.userId,
      name: args.deviceName.slice(0, 60),
      platform: args.platform.slice(0, 30),
      appVersion: args.appVersion.slice(0, 30),
      tokenHash: await sha256Hex(rawToken),
      status: "ACTIVE",
      pairedAt: now,
      lastSeenAt: now,
    });
    await audit(ctx, { actorUserId: pc.userId, targetUserId: pc.userId, action: "device.pair", metadata: { deviceId, replaced: actives.length } });
    return { deviceId, deviceToken: rawToken, userId: pc.userId };
  },
});

export async function listDevicesFor(ctx: QueryCtx, user: Doc<"users">) {
  const rows = await ctx.db.query("devices").withIndex("by_user", (q) => q.eq("userId", user._id)).collect();
  return rows
    .sort((a, b) => b.pairedAt - a.pairedAt)
    .map((d) => ({
      _id: d._id,
      name: d.name,
      platform: d.platform,
      appVersion: d.appVersion,
      status: d.status,
      pairedAt: d.pairedAt,
      lastSeenAt: d.lastSeenAt ?? null,
      online: d.status === "ACTIVE" && !!d.lastSeenAt && Date.now() - d.lastSeenAt < 90_000,
      snapshot: d.snapshot ?? null,
    }));
}

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    return await listDevicesFor(ctx, await requireUser(ctx));
  },
});

export const revoke = mutation({
  args: { deviceId: v.id("devices") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const d = await ctx.db.get(args.deviceId);
    if (!d || d.userId !== user._id) fail("NOT_FOUND", "디바이스를 찾을 수 없습니다.");
    await ctx.db.patch(d._id, { status: "REVOKED" });
    await stopJobsOwnedByDevice(ctx, user._id, d._id, "device_revoked", Date.now());
    await audit(ctx, { actorUserId: user._id, action: "device.revoke", metadata: { deviceId: d._id } });
  },
});

/** 웹에서 PC의 Codex 로그인 창을 시작한다. 자격증명은 PC에만 남는다. */
export const requestCodexLogin = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const devices = await ctx.db.query("devices").withIndex("by_user", (q) => q.eq("userId", user._id).eq("status", "ACTIVE")).collect();
    const device = devices.find((d) => !!d.lastSeenAt && Date.now() - d.lastSeenAt < 90_000);
    if (!device) fail("CONFLICT", "온라인 상태의 데스크톱 에이전트가 필요합니다.");
    const jobId = await enqueueJob(ctx, {
      userId: user._id,
      jobType: "codex.login",
      payload: {},
      source: "WEB",
      requestKey: `codex.login:${user._id}:${Math.floor(Date.now() / 60_000)}`,
    });
    await audit(ctx, { actorUserId: user._id, action: "device.codexLogin", metadata: { deviceId: device._id, jobId } });
    return { jobId };
  },
});

/** 에이전트 인증: Bearer 토큰 → 활성 디바이스 + 활성 유저 */
export const authenticate = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, args) => {
    const d = await ctx.db.query("devices").withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash)).unique();
    if (!d || d.status !== "ACTIVE") return null;
    const u = await ctx.db.get(d.userId);
    if (!u || (u.status ?? "ACTIVE") !== "ACTIVE") return null;
    return { deviceId: d._id, userId: d.userId };
  },
});

export const touch = internalMutation({
  args: { deviceId: v.id("devices"), appVersion: v.optional(v.string()), snapshot: v.optional(v.any()) },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.deviceId, { lastSeenAt: Date.now(), ...(args.appVersion ? { appVersion: args.appVersion } : {}), ...(args.snapshot !== undefined ? { snapshot: args.snapshot } : {}) });
  },
});
