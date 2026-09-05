import { v } from "convex/values";
import { generateCode, normalizeCode } from "@automoney/shared";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { httpAction, internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import { audit } from "./lib/audit";
import { sumEntries } from "./lib/commissionEngine";
import { sha256Hex, timingSafeEqual } from "./lib/crypto";
import { fail } from "./lib/errors";
import { requireUser } from "./lib/rbac";
import { kstMonth } from "./lib/time";
import { enqueueJob } from "./jobs";

const BIND_CODE_LENGTH = 6;
const BIND_TTL_MS = 10 * 60_000;
const MAX_MSG = 3600;

type Keyboard = { text: string; callback_data: string }[][];
interface Outgoing {
  chatId: string;
  text: string;
  keyboard?: Keyboard;
  userId?: Id<"users">;
}

// ─────────────────────────────── 바인딩 (웹) ───────────────────────────────

export const createBindCode = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const code = generateCode(BIND_CODE_LENGTH);
    const existing = await ctx.db.query("telegramBindings").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    const patch = { bindCodeHash: await sha256Hex(code), bindCodeExpiresAt: Date.now() + BIND_TTL_MS };
    if (existing) await ctx.db.patch(existing._id, patch);
    else await ctx.db.insert("telegramBindings", { userId: user._id, notify: true, ...patch });
    const bot = process.env.TELEGRAM_BOT_USERNAME ?? "";
    return { code, expiresAt: patch.bindCodeExpiresAt, deepLink: bot ? `https://t.me/${bot}?start=${code}` : null };
  },
});

export const getMine = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const b = await ctx.db.query("telegramBindings").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    return b ? { bound: !!b.chatId, boundAt: b.boundAt ?? null, notify: b.notify, botUsername: process.env.TELEGRAM_BOT_USERNAME ?? null } : { bound: false, boundAt: null, notify: true, botUsername: process.env.TELEGRAM_BOT_USERNAME ?? null };
  },
});

export const unbind = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const b = await ctx.db.query("telegramBindings").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    if (b) await ctx.db.patch(b._id, { chatId: undefined, boundAt: undefined });
  },
});

export const setNotify = mutation({
  args: { notify: v.boolean() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const b = await ctx.db.query("telegramBindings").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    if (!b) fail("NOT_FOUND", "텔레그램 바인딩이 없습니다.");
    await ctx.db.patch(b._id, { notify: args.notify });
  },
});

// ─────────────────────────────── 웹훅 ───────────────────────────────

export const webhook = httpAction(async (ctx, request) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const given = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!secret || !timingSafeEqual(secret, given)) return new Response("forbidden", { status: 403 });
  let update: unknown;
  try {
    update = await request.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  const out = await ctx.runMutation(internal.telegram.processUpdate, { update });
  for (const m of out.messages) await ctx.runAction(internal.telegram.send, m);
  if (out.answerCallbackQueryId) await ctx.runAction(internal.telegram.answerCallback, { callbackQueryId: out.answerCallbackQueryId, text: out.answerText ?? "" });
  return new Response("ok", { status: 200 });
});

interface TgUpdate {
  message?: { chat: { id: number | string }; text?: string; from?: { username?: string } };
  callback_query?: { id: string; data?: string; message?: { chat: { id: number | string } } };
}

/** 업데이트 처리(뮤테이션): 명령 해석 → 응답 메시지 목록. 외부 호출은 하지 않는다. */
export const processUpdate = internalMutation({
  args: { update: v.any() },
  handler: async (ctx, args): Promise<{ messages: Outgoing[]; answerCallbackQueryId?: string; answerText?: string }> => {
    const u = args.update as TgUpdate;
    if (u.callback_query) {
      const chatId = String(u.callback_query.message?.chat.id ?? "");
      const binding = chatId ? await bindingByChat(ctx, chatId) : null;
      if (!binding) return { messages: [], answerCallbackQueryId: u.callback_query.id, answerText: "연결되지 않은 채팅입니다." };
      const res = await handleCallback(ctx, binding, u.callback_query.data ?? "");
      return { messages: res.text ? [{ chatId, text: res.text, userId: binding.userId }] : [], answerCallbackQueryId: u.callback_query.id, answerText: res.toast };
    }
    const msg = u.message;
    if (!msg?.text) return { messages: [] };
    const chatId = String(msg.chat.id);
    const text = msg.text.trim();
    const [cmdRaw, ...rest] = text.split(/\s+/);
    const cmd = (cmdRaw ?? "").split("@")[0]!.toLowerCase();

    if (cmd === "/start") {
      const code = normalizeCode(rest[0] ?? "");
      if (!code) return reply(chatId, "automoney 봇입니다. 대시보드 > 텔레그램에서 발급한 6자리 코드를 `/start 코드` 형식으로 보내 주세요.");
      const hash = await sha256Hex(code);
      const row = await ctx.db.query("telegramBindings").withIndex("by_bindCodeHash", (q) => q.eq("bindCodeHash", hash)).unique();
      if (!row || (row.bindCodeExpiresAt ?? 0) < Date.now()) return reply(chatId, "코드가 만료되었거나 올바르지 않습니다. 대시보드에서 새 코드를 발급하세요.");
      // 같은 chatId 가 다른 유저에 묶여 있으면 해제
      const other = await bindingByChat(ctx, chatId);
      if (other && other._id !== row._id) await ctx.db.patch(other._id, { chatId: undefined, boundAt: undefined });
      await ctx.db.patch(row._id, { chatId, boundAt: Date.now(), bindCodeHash: undefined, bindCodeExpiresAt: undefined });
      await audit(ctx, { actorUserId: row.userId, action: "telegram.bind", metadata: { chatId } });
      return reply(chatId, "연결되었습니다. /status, /earnings, /links, /schedule, /post 명령을 사용할 수 있습니다.", row.userId);
    }

    const binding = await bindingByChat(ctx, chatId);
    if (!binding) return reply(chatId, "먼저 대시보드에서 발급한 코드로 `/start 코드` 를 보내 연결하세요.");
    const userId = binding.userId;

    switch (cmd) {
      case "/help":
        return reply(chatId, ["/status — 에이전트·스페이스 상태", "/earnings — 이번 달 실적·예상 수당", "/links — 최근 링크", "/schedule — 예약 목록", "/post <스페이스명> <내용> — 발행(승인 후 게시)", "/jobs — 최근 작업", "/content — 오늘 추천 콘텐츠 3개"].join("\n"), userId);
      case "/status": {
        const devices = await ctx.db.query("devices").withIndex("by_user", (q) => q.eq("userId", userId).eq("status", "ACTIVE")).collect();
        const spaces = await ctx.db.query("spaces").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
        const dev = devices[0];
        const online = dev?.lastSeenAt && Date.now() - dev.lastSeenAt < 90_000;
        const lines = [`에이전트: ${dev ? `${dev.name} (${online ? "온라인" : "오프라인"})` : "미연결"}`, `스페이스 ${spaces.length}개:`, ...spaces.map((s) => `- [${s.platform}] ${s.name}${s.handle ? ` @${s.handle}` : ""} · ${STATE_LABEL[s.sessionState] ?? s.sessionState}${s.pinned ? " · 고정" : ""}`)];
        return reply(chatId, lines.join("\n"), userId);
      }
      case "/earnings": {
        const month = kstMonth(Date.now());
        const stats = await ctx.db.query("userMonthlyStats").withIndex("by_user_month", (q) => q.eq("userId", userId).eq("month", month)).unique();
        const mine = await sumEntries(ctx, { beneficiaryUserId: userId, beneficiaryType: "USER", month });
        return reply(chatId, `${month} 실적\n클릭 ${stats?.clicks ?? 0} · 주문 ${stats?.directOrders ?? 0} · 매출 ${(stats?.directSales ?? 0).toLocaleString("ko-KR")}원\n예상 수당 ${mine.amount.toLocaleString("ko-KR")}원 (아뜨랑스 확정 전 추정)`, userId);
      }
      case "/links": {
        const links = await ctx.db.query("marketingLinks").withIndex("by_user", (q) => q.eq("userId", userId)).order("desc").take(5);
        if (links.length === 0) return reply(chatId, "발급한 링크가 없습니다. 대시보드에서 상품을 골라 발급하세요.", userId);
        const site = process.env.SITE_URL ?? "";
        const rows = [];
        for (const l of links) {
          const p = await ctx.db.get(l.productId);
          rows.push(`- ${p?.name ?? "(상품)"} · 클릭 ${l.clickCount}\n  ${site}/r/${l.shortCode}`);
        }
        return reply(chatId, rows.join("\n"), userId);
      }
      case "/schedule": {
        const rows = await ctx.db.query("schedules").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
        if (rows.length === 0) return reply(chatId, "예약이 없습니다. 대시보드 > 예약에서 등록하세요.", userId);
        const lines = [];
        for (const s of rows) {
          const sp = await ctx.db.get(s.spaceId);
          lines.push(`- ${sp?.name ?? "?"} · ${s.kind} ${s.timeOfDay} · ${s.enabled ? (s.nextRunAt ? `다음 ${fmtKst(s.nextRunAt)}` : "대기") : "중지"}`);
        }
        return reply(chatId, lines.join("\n"), userId);
      }
      case "/jobs": {
        const jobs = await ctx.db.query("agentJobs").withIndex("by_user", (q) => q.eq("userId", userId)).order("desc").take(5);
        if (jobs.length === 0) return reply(chatId, "작업이 없습니다.", userId);
        return reply(chatId, jobs.map((j) => `- ${j.jobType} · ${j.status}${j.errorCode ? ` (${j.errorCode})` : ""} · ${fmtKst(j.createdAt)}`).join("\n"), userId);
      }
      case "/content": {
        const mine = (await ctx.db.query("contentPieces").withIndex("by_owner", (q) => q.eq("ownerUserId", userId)).order("desc").take(20)).filter((p) => p.status === "APPROVED").slice(0, 3);
        const shared = mine.length < 3 ? await ctx.db.query("contentPieces").withIndex("by_visibility", (q) => q.eq("visibility", "SHARED").eq("status", "APPROVED")).order("desc").take(3 - mine.length) : [];
        const picks = [...mine, ...shared.filter((p) => !mine.some((m) => m._id === p._id))].slice(0, 3);
        if (picks.length === 0) return reply(chatId, "승인된 콘텐츠가 없습니다. 대시보드 > 콘텐츠에서 생성을 요청하세요(내 PC 의 Codex 가 생성).", userId);
        const lines = picks.map((p, i) => `${i + 1}. [${p.channel}] ${p.qualityScore}점${p.visibility === "SHARED" ? " · 공유" : ""}\n${p.caption.slice(0, 160)}${p.caption.length > 160 ? "…" : ""}`);
        return reply(chatId, ["오늘의 추천 콘텐츠", ...lines, "", "게시: /post <스페이스명> <내용> 또는 대시보드 > 콘텐츠 > 이 콘텐츠로 게시"].join("\n"), userId);
      }
      case "/post": {
        const spaceName = rest[0];
        const body = rest.slice(1).join(" ").trim();
        if (!spaceName || !body) return reply(chatId, "사용법: /post <스페이스명> <내용>", userId);
        const spaces = await ctx.db.query("spaces").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
        const space = spaces.find((s) => s.name === spaceName || s.handle === spaceName.replace(/^@/, ""));
        if (!space) return reply(chatId, `스페이스 "${spaceName}" 을 찾을 수 없습니다. /status 로 목록을 확인하세요.`, userId);
        try {
          const jobId = await enqueueJob(ctx, { userId, jobType: "post.publish", payload: { spaceId: space._id, platform: space.platform, text: body, mediaUrls: [], linkUrl: null }, spaceId: space._id, source: "TELEGRAM", needsApproval: true });
          return { messages: [{ chatId, userId, text: `[${space.platform}] ${space.name} 에 게시할까요?\n\n${body}`, keyboard: approvalKeyboard(jobId) }] };
        } catch (e) {
          return reply(chatId, `등록 실패: ${(e as { data?: { message?: string } }).data?.message ?? "내용을 확인하세요."}`, userId);
        }
      }
      default:
        return reply(chatId, "알 수 없는 명령입니다. /help 를 참고하세요.", userId);
    }
  },
});

const STATE_LABEL: Record<string, string> = { CREATED: "생성됨", LOGIN_REQUIRED: "로그인 필요", HEALTHY: "정상", RUNNING: "작업 중", EXPIRED: "세션 만료", RESTRICTED: "제한됨", PAUSED: "일시정지" };

function fmtKst(ts: number): string {
  return new Date(ts).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function reply(chatId: string, text: string, userId?: Id<"users">): { messages: Outgoing[] } {
  return { messages: [{ chatId, text, userId }] };
}

function approvalKeyboard(jobId: Id<"agentJobs">): Keyboard {
  return [[{ text: "✅ 게시", callback_data: `job:approve:${jobId}` }, { text: "❌ 취소", callback_data: `job:reject:${jobId}` }]];
}

async function bindingByChat(ctx: MutationCtx, chatId: string): Promise<Doc<"telegramBindings"> | null> {
  return await ctx.db.query("telegramBindings").withIndex("by_chatId", (q) => q.eq("chatId", chatId)).unique();
}

async function handleCallback(ctx: MutationCtx, binding: Doc<"telegramBindings">, data: string): Promise<{ text?: string; toast?: string }> {
  const m = /^job:(approve|reject):(.+)$/.exec(data);
  if (!m) return { toast: "알 수 없는 동작" };
  const job = await ctx.db.get(m[2] as Id<"agentJobs">);
  if (!job || job.userId !== binding.userId) return { toast: "작업을 찾을 수 없습니다." };
  const now = Date.now();
  if (m[1] === "approve") {
    if (job.status !== "NEEDS_APPROVAL") return { toast: `이미 ${job.status} 상태입니다.` };
    await ctx.db.patch(job._id, { status: "QUEUED", runAfter: now, updatedAt: now });
    await audit(ctx, { actorUserId: binding.userId, action: "job.approve", metadata: { jobId: job._id, via: "telegram" } });
    return { text: "승인했습니다. 에이전트가 곧 게시합니다.", toast: "승인됨" };
  }
  if (["NEEDS_APPROVAL", "QUEUED"].includes(job.status)) {
    await ctx.db.patch(job._id, { status: "CANCELLED", errorCode: "JOB_CANCELLED", finishedAt: now, updatedAt: now });
    return { text: "취소했습니다.", toast: "취소됨" };
  }
  return { toast: `이미 ${job.status} 상태입니다.` };
}

// ─────────────────────────────── 알림 ───────────────────────────────

export const bindingForUser = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => await ctx.db.query("telegramBindings").withIndex("by_user", (q) => q.eq("userId", args.userId)).unique(),
});

/** 잡 종료 알림 (completeJob 에서 스케줄) */
export const notifyJob = internalMutation({
  args: { jobId: v.id("agentJobs") },
  handler: async (ctx, args) => {
    const j = await ctx.db.get(args.jobId);
    if (!j || !["SUCCEEDED", "FAILED", "CANCELLED"].includes(j.status)) return;
    const b = await ctx.db.query("telegramBindings").withIndex("by_user", (q) => q.eq("userId", j.userId)).unique();
    if (!b?.chatId || !b.notify) return;
    const space = j.spaceId ? await ctx.db.get(j.spaceId) : null;
    const where = space ? `[${space.platform}] ${space.name}` : "";
    let text: string;
    if (j.status === "SUCCEEDED") {
      const url = (j.result as { data?: { postUrl?: string } } | undefined)?.data?.postUrl;
      text = `✅ ${j.jobType} 완료 ${where}${url ? `\n${url}` : ""}`;
    } else if (j.status === "FAILED") {
      text = `⚠️ ${j.jobType} 실패 ${where}\n${j.errorCode ?? ""} ${j.errorMessage ?? ""}`.trim();
      if (j.errorCode === "SPACE_SESSION_EXPIRED") text += "\n대시보드 > 스페이스에서 다시 로그인하세요.";
    } else text = `⏹ ${j.jobType} 취소됨 ${where}`;
    await ctx.scheduler.runAfter(0, internal.telegram.send, { chatId: b.chatId, text, userId: j.userId });
  },
});

/** 예약 발행 승인 요청 (schedules.tick 에서 스케줄) */
export const notifyApproval = internalMutation({
  args: { jobId: v.id("agentJobs") },
  handler: async (ctx, args) => {
    const j = await ctx.db.get(args.jobId);
    if (!j || j.status !== "NEEDS_APPROVAL") return;
    const b = await ctx.db.query("telegramBindings").withIndex("by_user", (q) => q.eq("userId", j.userId)).unique();
    if (!b?.chatId) return;
    const space = j.spaceId ? await ctx.db.get(j.spaceId) : null;
    const text = `예약 발행 승인 요청 [${space?.platform ?? ""}] ${space?.name ?? ""}\n\n${String((j.payload as { text?: string }).text ?? "").slice(0, 1500)}`;
    await ctx.scheduler.runAfter(0, internal.telegram.send, { chatId: b.chatId, text, userId: j.userId, keyboard: approvalKeyboard(j._id) });
  },
});

// ─────────────────────────────── Bot API ───────────────────────────────

export const recordOutbox = internalMutation({
  args: { userId: v.optional(v.id("users")), chatId: v.string(), text: v.string(), status: v.union(v.literal("SENT"), v.literal("SKIPPED_NO_TOKEN"), v.literal("FAILED")), detail: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await ctx.db.insert("telegramOutbox", { ...args, createdAt: Date.now() });
  },
});

/** 메시지 전송. 토큰이 없으면 outbox 에 기록만 (개발·테스트). 3600자 분할 (blogautomcp chatbot-notifier 계승). */
export const send = internalAction({
  args: { chatId: v.string(), text: v.string(), userId: v.optional(v.id("users")), keyboard: v.optional(v.any()) },
  handler: async (ctx, args) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chunks = splitMessage(args.text);
    if (!token) {
      await ctx.runMutation(internal.telegram.recordOutbox, { userId: args.userId, chatId: args.chatId, text: args.text, status: "SKIPPED_NO_TOKEN" });
      return { sent: false, reason: "no-token" };
    }
    for (let i = 0; i < chunks.length; i++) {
      const last = i === chunks.length - 1;
      const body: Record<string, unknown> = { chat_id: args.chatId, text: chunks.length > 1 ? `[${i + 1}/${chunks.length}] ${chunks[i]}` : chunks[i], disable_web_page_preview: false };
      if (last && args.keyboard) body.reply_markup = { inline_keyboard: args.keyboard };
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) {
        await ctx.runMutation(internal.telegram.recordOutbox, { userId: args.userId, chatId: args.chatId, text: args.text, status: "FAILED", detail: `HTTP ${res.status}` });
        return { sent: false, reason: `http-${res.status}` };
      }
    }
    await ctx.runMutation(internal.telegram.recordOutbox, { userId: args.userId, chatId: args.chatId, text: args.text, status: "SENT" });
    return { sent: true };
  },
});

export const answerCallback = internalAction({
  args: { callbackQueryId: v.string(), text: v.string() },
  handler: async (_ctx, args) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return;
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callback_query_id: args.callbackQueryId, text: args.text.slice(0, 200) }) });
  },
});

function splitMessage(text: string): string[] {
  if (text.length <= MAX_MSG) return [text];
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if ((cur + "\n" + line).length > MAX_MSG) {
      out.push(cur);
      cur = line;
    } else cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) out.push(cur);
  return out;
}
