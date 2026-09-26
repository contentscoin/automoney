import { MCP_TOOL_MAP, type Channel, type McpToolDef } from "@automoney/shared";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { audit } from "./audit";
import { fail } from "./errors";
import { roleOf } from "./rbac";
import { cancelJobFor, canonicalJson, enqueuePublishFor, listJobsFor } from "../jobs";
import { upsertScheduleFor } from "../schedules";
import { createSpaceFor, listSpacesFor, setPinnedFor } from "../spaces";
import { getPieceFor, listLibraryFor, requestGenerateFor } from "../content";
import { adminSummaryFor, superSummaryFor, userSummaryFor } from "../dashboard";
import { listLinksFor } from "../links";
import { searchProducts } from "../products";
import { listSettlementsFor } from "../settlements";
import { listMagazines } from "../magazines";
import { listCuration } from "../curation";
import { listDevicesFor } from "../devices";
import { latestMetricsForJob } from "../analytics";
import { consumePiece } from "./pieces";
import { marketingRedirectUrl } from "./publicUrl";
import { publicationIdentity } from "./publishIdentity";
import { sha256Hex } from "./crypto";

export interface McpCallContext {
  credentialId: Id<"mcpCredentials">;
  user: Doc<"users">;
  scopes: string[];
}

type Args = Record<string, unknown>;
const s = (a: Args, k: string) => (typeof a[k] === "string" ? (a[k] as string) : undefined);
const n = (a: Args, k: string) => (typeof a[k] === "number" ? (a[k] as number) : undefined);
const b = (a: Args, k: string) => (typeof a[k] === "boolean" ? (a[k] as boolean) : undefined);
const arr = (a: Args, k: string) => (Array.isArray(a[k]) ? (a[k] as unknown[]) : undefined);
const strs = (a: Args, k: string) => arr(a, k)?.filter((x): x is string => typeof x === "string");

function requireScope(call: McpCallContext, tool: McpToolDef) {
  if (!call.scopes.includes(tool.scope)) fail("FORBIDDEN", `scope ${tool.scope} required for ${tool.name}`);
  if (tool.scope === "admin:read" && !["ADMIN", "SUPER_ADMIN"].includes(roleOf(call.user))) fail("FORBIDDEN", "총판 이상만 사용할 수 있습니다.");
  if (tool.scope === "super:read" && roleOf(call.user) !== "SUPER_ADMIN") fail("FORBIDDEN", "수퍼어드민만 사용할 수 있습니다.");
}

async function publishPreviewBase(
  ctx: MutationCtx,
  user: Doc<"users">,
  input: { spaceId: Id<"spaces">; text: string; mediaUrls: string[]; contentChannel?: Channel; linkId?: Id<"marketingLinks">; pieceId?: Id<"contentPieces"> },
) {
  const space = await ctx.db.get(input.spaceId).catch(() => null);
  if (!space || space.userId !== user._id) fail("NOT_FOUND", "스페이스를 찾을 수 없습니다.");
  const targetIdentity = await publicationIdentity(ctx, space);
  let text = input.text;
  let mediaUrls = input.mediaUrls;
  let contentChannel = input.contentChannel;
  if (input.pieceId) {
    const piece = await consumePiece(ctx, user._id, input.pieceId);
    if (input.contentChannel && input.contentChannel !== piece.channel) fail("CONFLICT", "명시한 게시 형식과 콘텐츠 채널이 일치하지 않습니다.");
    contentChannel = piece.channel as Channel;
    if (piece.runId) {
      text = piece.text;
      mediaUrls = piece.mediaUrls;
    } else {
      if (!text.trim()) text = piece.text;
      if (mediaUrls.length === 0) mediaUrls = piece.mediaUrls;
    }
  }
  let linkUrl: string | null = null;
  if (input.linkId) {
    const link = await ctx.db.get(input.linkId);
    if (!link || link.userId !== user._id) fail("NOT_FOUND", "링크를 찾을 수 없습니다.");
    if (link.status !== "ACTIVE") fail("CONFLICT", "활성 상태의 링크만 게시에 사용할 수 있습니다.");
    linkUrl = marketingRedirectUrl(link.shortCode);
    if (!linkUrl) fail("CONFIG_MISSING", "SITE_URL은 공개 HTTPS 주소로 설정해야 합니다.");
  }
  return {
    space,
    targetPublicationKey: targetIdentity?.publicationKey ?? null,
    targetHandle: targetIdentity?.normalizedHandle ?? null,
    text,
    mediaUrls,
    contentChannel,
    linkUrl,
  };
}

/** 잡 뷰(MCP 응답용) — 결과 봉투 포함, 내부 필드 제외 */
async function jobView(ctx: MutationCtx, user: Doc<"users">, jobId: string) {
  const j = await ctx.db.get(jobId as Id<"agentJobs">).catch(() => null);
  if (!j || j.userId !== user._id) fail("NOT_FOUND", "작업을 찾을 수 없습니다.");
  const space = j.spaceId ? await ctx.db.get(j.spaceId) : null;
  return {
    jobId: j._id,
    jobType: j.jobType,
    status: j.status,
    stage: j.stage ?? null,
    progress: j.progress ?? null,
    executor: j.executor ?? "DESKTOP",
    source: j.source,
    space: space ? { spaceId: space._id, platform: space.platform, name: space.name } : null,
    result: j.result ?? null,
    errorCode: j.errorCode ?? null,
    errorMessage: j.errorMessage ?? null,
    publishPhase: j.publishPhase ?? null,
    manualPublishResolution: j.manualPublishResolution ?? null,
    createdAt: j.createdAt,
    finishedAt: j.finishedAt ?? null,
    postUrl: (j.result as { data?: { postUrl?: string } } | undefined)?.data?.postUrl ?? null,
  };
}

/**
 * 툴 디스패치(뮤테이션 컨텍스트). `link_issue` 는 액션 컨텍스트가 필요해 mcp.ts 의 HTTP 핸들러가 직접 처리한다.
 * 모든 호출은 auditEvents 에 `mcp.<tool>` 로 기록된다.
 */
export async function runMcpTool(ctx: MutationCtx, call: McpCallContext, name: string, rawArgs: unknown): Promise<unknown> {
  const tool = MCP_TOOL_MAP[name];
  if (!tool) fail("NOT_FOUND", `unknown tool: ${name}`);
  requireScope(call, tool);
  const a = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Args;
  const user = call.user;
  const site = process.env.SITE_URL ?? "";
  let result: unknown;
  switch (name) {
    case "agent_get_status": {
      const devices = await listDevicesFor(ctx, user);
      const spaces = await listSpacesFor(ctx, user);
      result = { devices: devices.map((d) => ({ deviceId: d._id, name: d.name, status: d.status, online: d.online, appVersion: d.appVersion })), spaces, minAppVersion: process.env.MIN_DESKTOP_VERSION ?? "0.1.0" };
      break;
    }
    case "product_search": {
      const rows = await searchProducts(ctx, { term: s(a, "term"), limit: Math.min(n(a, "limit") ?? 20, 50) });
      result = rows.map((p) => ({ productId: p._id, attrangsProductId: p.attrangsProductId, name: p.name, price: p.price, salePrice: p.salePrice ?? null, category: p.category ?? null, detailUrl: p.detailUrl }));
      break;
    }
    case "link_list": {
      const rows = await listLinksFor(ctx, user);
      result = rows.map((l) => ({ linkId: l._id, shortUrl: `${site}/r/${l.shortCode}`, shortCode: l.shortCode, status: l.status, clickCount: l.clickCount, product: l.product ? { productId: l.product._id, name: l.product.name } : null, issuedAt: l.issuedAt }));
      break;
    }
    case "earnings_get": {
      const sum = await userSummaryFor(ctx, user);
      // 화이트리스트: 간접 구매 필드 없음(유저 스코프)
      result = { month: sum.month, rateBps: sum.rateBps, current: sum.current, nextSettlement: sum.nextSettlement, kycStatus: sum.kycStatus, linkCount: sum.linkCount };
      break;
    }
    case "settlement_history":
      result = await listSettlementsFor(ctx, user);
      break;
    case "magazine_today":
      result = await listMagazines(ctx, { limit: Math.min(n(a, "limit") ?? 5, 20) });
      break;
    case "content_generate": {
      const jobId = await requestGenerateFor(ctx, user, { magazineId: s(a, "magazineId") as Id<"magazines"> | undefined, productId: s(a, "productId") as Id<"products"> | undefined, channels: (strs(a, "channels") ?? []) as never }, "MCP");
      result = { jobId, next: "job_get 으로 완료를 확인한 뒤 content_list 로 결과를 조회하세요." };
      break;
    }
    case "content_list":
      result = await listLibraryFor(ctx, user, { channel: s(a, "channel") as never, status: s(a, "status") as never, limit: n(a, "limit") });
      break;
    case "content_get":
      result = await getPieceFor(ctx, user, { pieceId: s(a, "pieceId") as Id<"contentPieces"> });
      break;
    case "curation_fetch":
      result = await listCuration(ctx, { kind: s(a, "kind") as never, productId: s(a, "productId") as Id<"products"> | undefined, limit: n(a, "limit") });
      break;
    case "space_list":
      result = await listSpacesFor(ctx, user);
      break;
    case "space_create": {
      if (b(a, "confirmed") !== true) {
        result = { requiresConfirmation: true, preview: { platform: s(a, "platform"), name: s(a, "name"), handle: s(a, "handle") ?? null }, message: "confirmed=true 로 다시 호출하면 스페이스를 생성합니다." };
        break;
      }
      result = await createSpaceFor(ctx, user, { platform: s(a, "platform") as never, name: s(a, "name") ?? "", handle: s(a, "handle") }, "MCP");
      break;
    }
    case "space_pin":
      await setPinnedFor(ctx, user, { spaceId: s(a, "spaceId") as Id<"spaces">, pinned: b(a, "pinned") ?? true });
      result = { ok: true };
      break;
    case "post_schedule": {
      const input = {
        spaceId: s(a, "spaceId") as Id<"spaces">,
        kind: (s(a, "kind") ?? "DAILY") as never,
        timeOfDay: s(a, "timeOfDay") ?? "",
        daysOfWeek: (arr(a, "daysOfWeek") ?? []).filter((x): x is number => typeof x === "number"),
        runDate: s(a, "runDate"),
        jitterMinutes: n(a, "jitterMinutes") ?? 15,
        text: s(a, "text") ?? "",
        mediaUrls: strs(a, "mediaUrls") ?? [],
        contentChannel: s(a, "contentChannel") as Channel | undefined,
        linkId: s(a, "linkId") as Id<"marketingLinks"> | undefined,
        pieceId: s(a, "pieceId") as Id<"contentPieces"> | undefined,
        autoApprove: b(a, "autoApprove") ?? false,
        clientRequestId: s(a, "clientRequestId"),
      };
      const preview = await publishPreviewBase(ctx, user, input);
      const confirmationHash = await sha256Hex(canonicalJson({
        spaceId: preview.space._id,
        platform: preview.space.platform,
        targetPublicationKey: preview.targetPublicationKey,
        targetHandle: preview.targetHandle,
        kind: input.kind,
        timeOfDay: input.timeOfDay,
        daysOfWeek: input.daysOfWeek,
        runDate: input.runDate ?? null,
        jitterMinutes: input.jitterMinutes,
        text: preview.text,
        mediaUrls: preview.mediaUrls,
        contentChannel: preview.contentChannel ?? null,
        linkId: input.linkId ?? null,
        linkUrl: preview.linkUrl,
        pieceId: input.pieceId ?? null,
        autoApprove: input.autoApprove,
      }));
      if (b(a, "confirmed") !== true || (input.autoApprove && b(a, "confirmAutoApprove") !== true)) {
        result = {
          requiresConfirmation: true,
          requiresAutoApproveConfirmation: input.autoApprove && b(a, "confirmAutoApprove") !== true,
          confirmationHash,
          preview: {
            space: { platform: preview.space.platform, name: preview.space.name, handle: preview.targetHandle },
            kind: input.kind,
            timeOfDay: input.timeOfDay,
            daysOfWeek: input.daysOfWeek,
            runDate: input.runDate ?? null,
            jitterMinutes: input.jitterMinutes,
            text: preview.text,
            mediaUrls: preview.mediaUrls,
            contentChannel: preview.contentChannel ?? null,
            linkId: input.linkId ?? null,
            linkUrl: preview.linkUrl,
            pieceId: input.pieceId ?? null,
            autoApprove: input.autoApprove,
          },
          message: input.autoApprove
            ? "confirmed=true와 confirmAutoApprove=true로 다시 호출해야 반복 무승인 게시 예약을 등록합니다."
            : "confirmed=true로 다시 호출하면 매 실행마다 사람 승인이 필요한 예약을 등록합니다.",
        };
        break;
      }
      if (!input.clientRequestId) fail("INVALID_ARGUMENT", "confirmed 예약 등록에는 clientRequestId가 필요합니다.");
      if (input.autoApprove && s(a, "confirmationHash") !== confirmationHash)
        fail("CONFLICT", "자동 승인 예약의 확인 snapshot이 없거나 변경되었습니다. 미리보기를 다시 확인하세요.");
      result = await upsertScheduleFor(ctx, user, input);
      break;
    }
    case "post_publish": {
      const input = { spaceId: s(a, "spaceId") as Id<"spaces">, text: s(a, "text") ?? "", mediaUrls: strs(a, "mediaUrls") ?? [], contentChannel: s(a, "contentChannel") as Channel | undefined, linkId: s(a, "linkId") as Id<"marketingLinks"> | undefined, pieceId: s(a, "pieceId") as Id<"contentPieces"> | undefined, requireApproval: b(a, "requireApproval") ?? true, dryRun: b(a, "dryRun") ?? false, clientRequestId: s(a, "clientRequestId") };
      const preview = await publishPreviewBase(ctx, user, input);
      const confirmationSnapshot = {
        spaceId: preview.space._id,
        platform: preview.space.platform,
        name: preview.space.name,
        targetPublicationKey: preview.targetPublicationKey,
        targetHandle: preview.targetHandle,
        text: preview.text,
        mediaUrls: preview.mediaUrls,
        contentChannel: preview.contentChannel ?? null,
        linkId: input.linkId ?? null,
        linkUrl: preview.linkUrl,
        pieceId: input.pieceId ?? null,
        requireApproval: input.requireApproval,
        dryRun: input.dryRun,
      };
      const confirmationHash = await sha256Hex(canonicalJson(confirmationSnapshot));
      if (b(a, "confirmed") !== true) {
        result = { requiresConfirmation: true, confirmationHash, preview: { space: { platform: preview.space.platform, name: preview.space.name, handle: preview.targetHandle, authMode: preview.space.authMode ?? "BROWSER" }, contentChannel: preview.contentChannel ?? null, text: preview.text, mediaUrls: preview.mediaUrls, linkId: input.linkId ?? null, linkUrl: preview.linkUrl, pieceId: input.pieceId ?? null, requireApproval: input.requireApproval, dryRun: input.dryRun }, message: input.requireApproval ? "confirmed=true 로 다시 호출하면 최종 사람 승인 대기 잡을 등록합니다." : "무승인 게시이므로 preview의 confirmationHash를 confirmationHash 인자로 그대로 보내고 confirmed=true로 다시 호출해야 합니다." };
        break;
      }
      if (!input.clientRequestId) fail("INVALID_ARGUMENT", "confirmed 발행 등록에는 clientRequestId가 필요합니다.");
      if (!input.requireApproval && s(a, "confirmationHash") !== confirmationHash)
        fail("CONFLICT", "무승인 게시의 확인 snapshot이 없거나 변경되었습니다. 미리보기를 다시 확인하세요.");
      const jobId = await enqueuePublishFor(ctx, user, input, "MCP");
      result = { jobId, requiresApproval: input.requireApproval, next: "job_get / post_verify_published 로 결과를 확인하세요." };
      break;
    }
    case "post_verify_published": {
      const job = await jobView(ctx, user, s(a, "jobId") ?? "");
      const metrics = await latestMetricsForJob(ctx, job.jobId as Id<"agentJobs">);
      result = {
        published: job.publishPhase === "CONFIRMED" && !!job.postUrl,
        postUrl: job.postUrl,
        publishPhase: job.publishPhase,
        executionStatus: job.status,
        manualPublishResolution: job.manualPublishResolution,
        errorCode: job.errorCode,
        metrics,
      };
      break;
    }
    case "job_get":
      result = await jobView(ctx, user, s(a, "jobId") ?? "");
      break;
    case "job_cancel":
      await cancelJobFor(ctx, user, { jobId: s(a, "jobId") as Id<"agentJobs"> });
      result = { ok: true };
      break;
    case "admin_team_stats":
      result = await adminSummaryFor(ctx, user, { month: s(a, "month") });
      break;
    case "super_stats":
      result = await superSummaryFor(ctx, { month: s(a, "month") });
      break;
    default:
      fail("NOT_FOUND", `unhandled tool: ${name}`);
  }
  await audit(ctx, { actorUserId: user._id, action: `mcp.${name}`, metadata: { credentialId: call.credentialId, args: a } });
  return result;
}

export { listJobsFor };
