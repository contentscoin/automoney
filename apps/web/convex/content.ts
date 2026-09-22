import { v, type ObjectType } from "convex/values";
import {
  CHANNELS,
  DEFAULT_CONTENT_STANDARD,
  evaluatePiece,
  isAutoApprovable,
  normalizeContentBrief,
  passesContentStandard,
  type Channel,
  type ContentGeneratePayload,
  type ContentProductionBrief,
  type ContentProductionStandard,
  type GeneratedPiece,
  type ProductBrief,
} from "@automoney/shared";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { audit } from "./lib/audit";
import { fail } from "./lib/errors";
import { sha256Hex } from "./lib/crypto";
import { requireSuperAdmin, requireUser, roleOf } from "./lib/rbac";
import { canonicalJson, enqueueJob } from "./jobs";
import { playbookHintsFor } from "./analytics";

/** 내 거절 사유 상위 3개(생성 프롬프트 "피해야 할 것") */
async function topRejectionReasons(ctx: MutationCtx, userId: Id<"users">): Promise<string[]> {
  const rows = await ctx.db.query("contentRejections").withIndex("by_user", (q) => q.eq("userId", userId)).order("desc").take(50);
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.reason, (by.get(r.reason) ?? 0) + 1);
  return [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, n]) => `${r} (${n}회 거절)`);
}

const channelValidator = v.union(
  v.literal("INSTAGRAM_FEED"),
  v.literal("INSTAGRAM_REEL"),
  v.literal("THREADS"),
  v.literal("X"),
  v.literal("TIKTOK"),
  v.literal("BLOG"),
);

const briefInputValidator = v.optional(v.any());
const standardInputValidator = v.optional(v.any());
export const MIN_CONTENT_DESKTOP_VERSION = "0.1.11";

export function versionAtLeast(actual: string, required: string): boolean {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const left = parse(actual);
  const right = parse(required);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index++) {
    if (left[index]! !== right[index]!) return left[index]! > right[index]!;
  }
  return true;
}

function productionStandard(input: unknown): ContentProductionStandard {
  const raw = input && typeof input === "object" && !Array.isArray(input)
    ? input as Partial<ContentProductionStandard>
    : {};
  const finite = (value: unknown, fallback: number, min: number, max: number) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.min(max, Math.max(min, Math.round(value)))
      : fallback;
  return {
    ...DEFAULT_CONTENT_STANDARD,
    // Contract identity and retry behavior are server-owned. Callers may only tighten thresholds.
    id: DEFAULT_CONTENT_STANDARD.id,
    version: DEFAULT_CONTENT_STANDARD.version,
    name: DEFAULT_CONTENT_STANDARD.name,
    brand: DEFAULT_CONTENT_STANDARD.brand,
    minScore: Math.max(DEFAULT_CONTENT_STANDARD.minScore, finite(raw.minScore, DEFAULT_CONTENT_STANDARD.minScore, 0, 100)),
    requireCodex: DEFAULT_CONTENT_STANDARD.requireCodex,
    maxAttempts: DEFAULT_CONTENT_STANDARD.maxAttempts,
    maxEmoji: Math.min(DEFAULT_CONTENT_STANDARD.maxEmoji, finite(raw.maxEmoji, DEFAULT_CONTENT_STANDARD.maxEmoji, 0, 10)),
    forbiddenPhrases: Array.isArray(raw.forbiddenPhrases)
      ? [...new Set([
          ...DEFAULT_CONTENT_STANDARD.forbiddenPhrases,
          ...raw.forbiddenPhrases.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 50).map((item) => item.trim().slice(0, 100)),
        ])]
      : [...DEFAULT_CONTENT_STANDARD.forbiddenPhrases],
    workflowVersion: DEFAULT_CONTENT_STANDARD.workflowVersion,
    promptVersion: DEFAULT_CONTENT_STANDARD.promptVersion,
    qualityVersion: DEFAULT_CONTENT_STANDARD.qualityVersion,
  };
}

async function createContentRun(
  ctx: MutationCtx,
  input: {
    userId: Id<"users">;
    productIds: Id<"products">[];
    channels: Channel[];
    brief: ContentProductionBrief;
    standard: ContentProductionStandard;
    expectedOutputs: number;
  },
): Promise<Id<"contentRuns">> {
  const productIds = input.productIds.filter((id, index) => input.productIds.indexOf(id) === index);
  const channels = input.channels.filter((channel, index) => input.channels.indexOf(channel) === index);
  const productSnapshots = [];
  for (const productId of productIds) {
    const product = await ctx.db.get(productId);
    if (!product) fail("NOT_FOUND", "상품을 찾을 수 없습니다.");
    productSnapshots.push({
      productId: product._id,
      attrangsProductId: product.attrangsProductId,
      name: product.name,
      price: product.price,
      salePrice: product.salePrice ?? null,
      category: product.category ?? null,
      detailUrl: product.detailUrl,
      imageUrls: product.imageUrls,
      status: product.status,
      syncedAt: product.syncedAt,
      source: product.source,
    });
  }
  const inputHash = await sha256Hex(canonicalJson({
    products: productSnapshots,
    channels,
    brief: input.brief,
    standard: input.standard,
  }));
  const now = Date.now();
  return await ctx.db.insert("contentRuns", {
    userId: input.userId,
    batchKey: `content:${inputHash.slice(0, 16)}:${now}`,
    productIds,
    productSnapshots,
    channels,
    briefSnapshot: input.brief,
    standardSnapshot: input.standard,
    inputHash,
    jobIds: [],
    expectedOutputs: input.expectedOutputs,
    completedJobs: 0,
    savedOutputs: 0,
    approvedOutputs: 0,
    status: "QUEUED",
    createdAt: now,
    updatedAt: now,
  });
}

/** 유저: 매거진 또는 상품 기준으로 채널별 콘텐츠 생성 요청 → 내 PC 의 Codex 가 수행 */
const requestGenerateArgs = {
    magazineId: v.optional(v.id("magazines")),
    productId: v.optional(v.id("products")),
    channels: v.array(channelValidator),
    brief: briefInputValidator,
    standard: standardInputValidator,
  };

type RequestGenerateForArgs = ObjectType<typeof requestGenerateArgs> & {
  runId?: Id<"contentRuns">;
};

export async function requestGenerateFor(ctx: MutationCtx, user: Doc<"users">, args: RequestGenerateForArgs, source: "WEB" | "MCP" = "WEB") {
  if (args.channels.length === 0)
    fail("INVALID_ARGUMENT", "채널을 하나 이상 선택하세요.");
  if (!args.magazineId && !args.productId)
    fail("INVALID_ARGUMENT", "매거진 또는 상품을 선택하세요.");
  const device = (
    await ctx.db
      .query("devices")
      .withIndex("by_user", (q) =>
        q.eq("userId", user._id).eq("status", "ACTIVE"),
      )
      .collect()
  )[0];
  if (!device)
    fail(
      "CONFLICT",
      "콘텐츠 생성은 내 PC 의 에이전트(Codex)가 수행합니다. 먼저 데스크톱 에이전트를 페어링하세요.",
    );
  if (!device.lastSeenAt || Date.now() - device.lastSeenAt >= 90_000)
    fail("CONFLICT", "데스크톱 에이전트가 오프라인입니다. PC 앱을 실행한 뒤 다시 요청하세요.");
  if (!versionAtLeast(device.appVersion, MIN_CONTENT_DESKTOP_VERSION))
    fail(
      "CONFLICT",
      `동일 품질 계약을 실행하려면 데스크톱 앱 ${MIN_CONTENT_DESKTOP_VERSION} 이상이 필요합니다. 앱을 업데이트한 뒤 다시 요청하세요.`,
    );

  let channels = args.channels.filter((channel, index) => args.channels.indexOf(channel) === index);
  let brief = normalizeContentBrief(args.brief as Partial<ContentProductionBrief> | null | undefined);
  let standard = productionStandard(args.standard);
  const atoms: ContentGeneratePayload["atoms"] = [];
  const products: ProductBrief[] = [];
  const runProductIds: Id<"products">[] = [];
  let magazineTitle: string | null = null;
  if (args.magazineId) {
    const m = await ctx.db.get(args.magazineId);
    if (!m || m.status !== "ACTIVE")
      fail("NOT_FOUND", "매거진을 찾을 수 없습니다.");
    magazineTitle = m.title;
    for (const a of await ctx.db
      .query("contentAtoms")
      .withIndex("by_magazine", (q) => q.eq("magazineId", m._id))
      .collect())
      atoms.push({
        atomType: a.atomType,
        text: a.text,
        productId: a.attrangsProductId ?? null,
        rank: a.rank,
      });
    for (const pid of m.productIds.slice(0, 5)) {
      const p = await ctx.db.get(pid);
      if (p) {
        products.push(productBrief(p));
        runProductIds.push(p._id);
      }
    }
  }
  if (args.productId) {
    const p = await ctx.db.get(args.productId);
    if (!p) fail("NOT_FOUND", "상품을 찾을 수 없습니다.");
    if (!products.some((b) => b.attrangsProductId === p.attrangsProductId))
      products.unshift(productBrief(p));
    if (!runProductIds.includes(p._id)) runProductIds.unshift(p._id);
    // 상품만 있는 경우 큐레이션 제품 정보를 원자로 보강
    const facts = await ctx.db
      .query("curationItems")
      .withIndex("by_product", (q) =>
        q.eq("productId", p._id).eq("kind", "PRODUCT_FACT"),
      )
      .collect();
    for (const f of facts)
      if (f.body)
        atoms.push({
          atomType: "PRODUCT_POINT",
          text: f.body,
          productId: p.attrangsProductId,
          rank: atoms.length + 1,
        });
  }
  let runId = args.runId;
  if (runId) {
    const run = await ctx.db.get(runId);
    if (!run || run.userId !== user._id) fail("NOT_FOUND", "콘텐츠 제작 실행을 찾을 수 없습니다.");
    if (args.productId && !run.productIds.includes(args.productId)) fail("INVALID_ARGUMENT", "제작 실행에 포함되지 않은 상품입니다.");
    // Once a run exists, its frozen snapshots—not later caller input—are authoritative.
    channels = [...run.channels];
    brief = normalizeContentBrief(run.briefSnapshot as Partial<ContentProductionBrief>);
    standard = productionStandard(run.standardSnapshot);
  } else {
    runId = await createContentRun(ctx, {
      userId: user._id,
      productIds: runProductIds,
      channels,
      brief,
      standard,
      expectedOutputs: channels.length,
    });
  }
  const payload: ContentGeneratePayload = {
    channels,
    atoms: atoms.slice(0, 20),
    products,
    magazineId: args.magazineId ?? null,
    magazineTitle,
    brand: standard.brand,
    playbook: await playbookHintsFor(ctx, user._id, channels),
    avoid: await topRejectionReasons(ctx, user._id),
    runId,
    brief,
    standard,
  };
  const jobId = await enqueueJob(ctx, {
    userId: user._id,
    jobType: "content.generate",
    payload: payload as unknown as Record<string, unknown>,
    source,
  });
  const run = await ctx.db.get(runId);
  if (run && !run.jobIds.includes(jobId)) {
    await ctx.db.patch(run._id, {
      jobIds: [...run.jobIds, jobId],
      updatedAt: Date.now(),
    });
  }
  await audit(ctx, {
    actorUserId: user._id,
    action: "content.requestGenerate",
    metadata: {
      jobId,
      runId,
      channels,
      magazineId: args.magazineId ?? null,
      productId: args.productId ?? null,
    },
  });
  return jobId;
}

export const requestGenerate = mutation({
  args: requestGenerateArgs,
  handler: async (ctx, args) => {
    return await requestGenerateFor(ctx, await requireUser(ctx), args);
  },
});

/** 콘텐츠 제작 워크플로: 상품별 생성 잡을 최대 10개까지 한 번에 등록한다. */
export const requestGenerateBatch = mutation({
  args: {
    productIds: v.array(v.id("products")),
    channels: v.array(channelValidator),
    brief: briefInputValidator,
    standard: standardInputValidator,
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (args.productIds.length === 0) fail("INVALID_ARGUMENT", "상품을 하나 이상 선택하세요.");
    if (args.productIds.length > 10) fail("INVALID_ARGUMENT", "한 번에 상품을 최대 10개까지 선택할 수 있습니다.");
    const productIds = args.productIds.filter((id, index) => args.productIds.indexOf(id) === index);
    const channels = args.channels.filter((channel, index) => args.channels.indexOf(channel) === index);
    if (channels.length === 0) fail("INVALID_ARGUMENT", "채널을 하나 이상 선택하세요.");
    const brief = normalizeContentBrief(args.brief as Partial<ContentProductionBrief> | null | undefined);
    const standard = productionStandard(args.standard);
    const runId = await createContentRun(ctx, {
      userId: user._id,
      productIds,
      channels,
      brief,
      standard,
      expectedOutputs: productIds.length * channels.length,
    });
    const jobIds = [];
    for (const productId of productIds) {
      jobIds.push(await requestGenerateFor(ctx, user, {
        productId,
        channels,
        brief,
        standard,
        runId,
      }, "WEB"));
    }
    await ctx.db.patch(runId, { jobIds, updatedAt: Date.now() });
    await audit(ctx, {
      actorUserId: user._id,
      action: "content.requestGenerateBatch",
      metadata: { runId, productCount: productIds.length, channels, jobIds },
    });
    return { total: jobIds.length, runId, jobIds };
  },
});

async function contentRunView(ctx: QueryCtx, run: Doc<"contentRuns">) {
  const pieces = await ctx.db
    .query("contentPieces")
    .withIndex("by_run", (q) => q.eq("runId", run._id))
    .collect();
  let completedJobs = 0;
  let failedJobs = 0;
  let runningJobs = 0;
  for (const jobId of run.jobIds) {
    const job = await ctx.db.get(jobId);
    if (!job) continue;
    if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(job.status)) completedJobs++;
    if (job.status === "FAILED" || job.status === "CANCELLED") failedJobs++;
    if (job.status === "RUNNING") runningJobs++;
  }
  const savedOutputs = pieces.length;
  const approvedOutputs = pieces.filter((piece) =>
    piece.status === "APPROVED"
    && (piece.productionMeta as { standardPassed?: boolean } | undefined)?.standardPassed === true
  ).length;
  let status: Doc<"contentRuns">["status"] = run.status;
  if (run.jobIds.length === 0) status = "QUEUED";
  else if (completedJobs === run.jobIds.length) {
    if (failedJobs === run.jobIds.length && savedOutputs === 0) status = "FAILED";
    else status = approvedOutputs === run.expectedOutputs ? "COMPLETED" : "REVIEW_REQUIRED";
  } else if (completedJobs > 0 || runningJobs > 0) status = "RUNNING";
  else status = "QUEUED";
  return {
    _id: run._id,
    batchKey: run.batchKey,
    productIds: run.productIds,
    productSnapshots: run.productSnapshots,
    channels: run.channels,
    briefSnapshot: run.briefSnapshot as ContentProductionBrief,
    standardSnapshot: run.standardSnapshot as ContentProductionStandard,
    inputHash: run.inputHash,
    jobIds: run.jobIds,
    expectedOutputs: run.expectedOutputs,
    completedJobs,
    savedOutputs,
    approvedOutputs,
    status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

/** Recent content-production runs, including counters derived from their jobs and pieces. */
export const listRuns = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const rows = await ctx.db
      .query("contentRuns")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(Math.min(Math.max(args.limit ?? 20, 1), 100));
    return await Promise.all(rows.map((run) => contentRunView(ctx, run)));
  },
});

export const getRun = query({
  args: { runId: v.id("contentRuns") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const run = await ctx.db.get(args.runId);
    if (!run || run.userId !== user._id) fail("NOT_FOUND", "콘텐츠 제작 실행을 찾을 수 없습니다.");
    return await contentRunView(ctx, run);
  },
});

/** A run-scoped result query avoids truncation and cross-run mixing in the library view. */
export const listRunPieces = query({
  args: { runId: v.id("contentRuns") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const run = await ctx.db.get(args.runId);
    if (!run || run.userId !== user._id) fail("NOT_FOUND", "콘텐츠 제작 실행을 찾을 수 없습니다.");
    const rows = await ctx.db
      .query("contentPieces")
      .withIndex("by_run", (q) => q.eq("runId", run._id))
      .collect();
    return await decorate(ctx, rows.sort((a, b) => b.createdAt - a.createdAt), user._id);
  },
});

function productBrief(p: Doc<"products">): ProductBrief {
  return {
    attrangsProductId: p.attrangsProductId,
    name: p.name,
    price: p.price,
    salePrice: p.salePrice ?? null,
    category: p.category ?? null,
  };
}

async function refreshContentRun(ctx: MutationCtx, runId: Id<"contentRuns">): Promise<void> {
  const run = await ctx.db.get(runId);
  if (!run) return;
  const pieces = await ctx.db
    .query("contentPieces")
    .withIndex("by_run", (q) => q.eq("runId", run._id))
    .collect();
  let completedJobs = 0;
  let failedJobs = 0;
  for (const jobId of run.jobIds) {
    const job = await ctx.db.get(jobId);
    if (!job) continue;
    if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(job.status)) completedJobs++;
    if (job.status === "FAILED" || job.status === "CANCELLED") failedJobs++;
  }
  const approvedOutputs = pieces.filter((piece) =>
    piece.status === "APPROVED"
    && (piece.productionMeta as { standardPassed?: boolean } | undefined)?.standardPassed === true
  ).length;
  const finished = run.jobIds.length > 0 && completedJobs === run.jobIds.length;
  const status: Doc<"contentRuns">["status"] = finished
    ? failedJobs === run.jobIds.length && pieces.length === 0
      ? "FAILED"
      : approvedOutputs === run.expectedOutputs
        ? "COMPLETED"
        : "REVIEW_REQUIRED"
    : completedJobs > 0 ? "RUNNING" : "QUEUED";
  await ctx.db.patch(run._id, {
    completedJobs,
    savedOutputs: pieces.length,
    approvedOutputs,
    status,
    updatedAt: Date.now(),
  });
}

/** 에이전트 결과 수신(agent.completeJob 훅): 품질 게이트 → 라이브러리 저장 */
export const ingestGenerated = internalMutation({
  args: { jobId: v.id("agentJobs") },
  handler: async (ctx, args) => ingestGeneratedJob(ctx, args.jobId),
});

/** content.generate 잡 성공 결과 → 품질 게이트 → 라이브러리 저장 (agent.completeJob 에서 직접 호출) */
export async function ingestGeneratedJob(
  ctx: MutationCtx,
  jobId: Id<"agentJobs">,
): Promise<{ saved: number; approved: number; duplicate?: boolean }> {
  const job = await ctx.db.get(jobId);
  if (!job || job.jobType !== "content.generate") return { saved: 0, approved: 0 };
  if (job.status !== "SUCCEEDED") {
    const failedPayload = job.payload as { runId?: unknown };
    if (typeof failedPayload.runId === "string") {
      const failedRun = await ctx.db.get(failedPayload.runId as Id<"contentRuns">);
      if (failedRun?.userId === job.userId) await refreshContentRun(ctx, failedRun._id);
    }
    return { saved: 0, approved: 0 };
  }
  const dup = await ctx.db
    .query("contentPieces")
    .withIndex("by_job", (q) => q.eq("jobId", job._id))
    .first();
  if (dup) return { saved: 0, approved: 0, duplicate: true };
  const data = (
    job.result as
      | { data?: { pieces?: unknown[]; generatedBy?: string; engine?: string; model?: string } }
      | undefined
  )?.data;
  const pieces = Array.isArray(data?.pieces) ? data.pieces : [];
  const payload = job.payload as ContentGeneratePayload;
  const jobProvider = data?.generatedBy === "codex" ? "codex" : "template";
  const runId = typeof payload.runId === "string" ? payload.runId as Id<"contentRuns"> : undefined;
  const run = runId ? await ctx.db.get(runId) : null;
  const ownedRun = run?.userId === job.userId ? run : null;
  const productionBrief = normalizeContentBrief(
    (payload.brief ?? ownedRun?.briefSnapshot) as Partial<ContentProductionBrief> | null | undefined,
  );
  const strictRun = !!ownedRun || payload.standard !== undefined;
  const standard = strictRun ? productionStandard(payload.standard ?? ownedRun?.standardSnapshot) : undefined;
  const manifestHash = ownedRun?.inputHash ?? await sha256Hex(canonicalJson({
    channels: payload.channels,
    products: payload.products,
    atoms: payload.atoms,
    brief: productionBrief,
    standard: standard ?? null,
  }));
  const jobInputHash = job.payloadHash ?? await sha256Hex(canonicalJson({ jobType: job.jobType, payload: job.payload }));
  const claimedDevice = job.claimedByDeviceId ? await ctx.db.get(job.claimedByDeviceId) : null;
  const frozenProduct = ownedRun && payload.products[0]
    ? ownedRun.productSnapshots.find((snapshot) => snapshot.attrangsProductId === payload.products[0]!.attrangsProductId) ?? null
    : null;
  const legacyMagazine = !ownedRun && payload.magazineId
    ? await ctx.db.get(payload.magazineId as Id<"magazines">)
    : null;
  const legacyProduct = !ownedRun && payload.products[0]
    ? await ctx.db
        .query("products")
        .withIndex("by_attrangsProductId", (q) =>
          q.eq("attrangsProductId", payload.products[0]!.attrangsProductId),
        )
        .unique()
    : null;
  let saved = 0;
  let approved = 0;
  const seenChannels = new Set<Channel>();
  for (const rawValue of pieces) {
    if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) continue;
    const raw = rawValue as Partial<GeneratedPiece>;
    if (typeof raw.channel !== "string" || !CHANNELS.includes(raw.channel as Channel)) continue;
    const channel = raw.channel as Channel;
    if (!payload.channels.includes(channel) || seenChannels.has(channel)) continue;
    seenChannels.add(channel);
    const schemaValid = typeof raw.caption === "string"
      && Array.isArray(raw.hashtags)
      && raw.hashtags.every((hashtag) => typeof hashtag === "string")
      && (raw.script === undefined || raw.script === null || typeof raw.script === "string");
    const candidate: GeneratedPiece = {
      channel,
      caption: typeof raw.caption === "string" ? raw.caption : "",
      hashtags: Array.isArray(raw.hashtags) ? raw.hashtags.filter((hashtag): hashtag is string => typeof hashtag === "string") : [],
      script: typeof raw.script === "string" || raw.script === null ? raw.script : null,
      ...(raw.generatedBy === "codex" || raw.generatedBy === "template" || raw.generatedBy === "manual" ? { generatedBy: raw.generatedBy } : {}),
      ...(typeof raw.attemptNo === "number" && Number.isFinite(raw.attemptNo) ? { attemptNo: raw.attemptNo } : {}),
    };
    const provenanceComplete = candidate.generatedBy === "codex" || candidate.generatedBy === "template" || candidate.generatedBy === "manual";
    const provider = strictRun
      ? provenanceComplete ? candidate.generatedBy! : "template"
      : provenanceComplete ? candidate.generatedBy! : jobProvider;
    const attemptNo = typeof candidate.attemptNo === "number" && Number.isFinite(candidate.attemptNo)
      ? Math.min(standard?.maxAttempts ?? 5, Math.max(1, Math.round(candidate.attemptNo)))
      : Math.min(standard?.maxAttempts ?? 5, Math.max(1, job.attemptNo ?? 1));
    const evaluationProducts: ProductBrief[] = frozenProduct
      ? [{
          attrangsProductId: frozenProduct.attrangsProductId,
          name: frozenProduct.name,
          price: frozenProduct.price,
          salePrice: frozenProduct.salePrice,
          category: frozenProduct.category,
        }]
      : payload.products;
    const report = evaluatePiece(candidate, {
      linkExpected: true,
      products: evaluationProducts,
      brief: productionBrief,
      ...(standard ? { standard } : {}),
    });
    const appendBlock = (code: string, message: string) => {
      if (!report.violations.some((violation) => violation.code === code)) {
        report.violations.push({ code, message, severity: "block" });
        report.score = Math.max(0, report.score - 40);
      }
    };
    if (!schemaValid) appendBlock("INVALID_OUTPUT_SCHEMA", "생성 결과의 본문·해시태그·대본 형식이 올바르지 않습니다.");
    if (strictRun && !provenanceComplete)
      appendBlock("PROVENANCE_MISSING", "V2 결과에는 조각별 생성 출처가 필요합니다. 데스크톱 앱을 업데이트해 다시 생성하세요.");
    const standardPassed = standard
      ? isAutoApprovable(report) && passesContentStandard(report, provider, standard)
      : isAutoApprovable(report);
    const outputHash = await sha256Hex(canonicalJson({
      channel,
      caption: report.caption,
      hashtags: report.hashtags,
      script: candidate.script ?? null,
      provider,
      attemptNo,
    }));
    const status = strictRun ? "DRAFT" as const : standardPassed ? "APPROVED" as const : "DRAFT" as const;
    await ctx.db.insert("contentPieces", {
      ownerUserId: job.userId,
      visibility: "PRIVATE",
      magazineId: ownedRun && payload.magazineId ? payload.magazineId as Id<"magazines"> : legacyMagazine?._id,
      productId: frozenProduct?.productId ?? legacyProduct?._id,
      channel,
      caption: report.caption,
      hashtags: report.hashtags,
      script: candidate.script ?? undefined,
      mediaUrls: frozenProduct?.imageUrls.slice(0, 4)
        ?? (legacyMagazine?.imageUrls.length ? legacyMagazine.imageUrls.slice(0, 4) : legacyProduct?.imageUrls.slice(0, 4) ?? []),
      qualityScore: report.score,
      qualityReport: { violations: report.violations, fixed: report.fixed },
      status,
      generatedBy: provider,
      runId: ownedRun?._id,
      productionMeta: standard ? {
        workflowVersion: standard.workflowVersion,
        promptVersion: standard.promptVersion,
        qualityVersion: standard.qualityVersion,
        standardId: standard.id,
        standardVersion: standard.version,
        provider,
        attemptNo,
        inputHash: manifestHash,
        manifestHash,
        jobInputHash,
        outputHash,
        desktopVersion: claimedDevice?.appVersion ?? null,
        engine: typeof data?.engine === "string" ? data.engine.slice(0, 80) : provider === "codex" ? "codex-cli" : "template",
        model: typeof data?.model === "string" ? data.model.slice(0, 80) : null,
        provenanceComplete,
        standardPassed,
        evaluatedAt: Date.now(),
      } : undefined,
      jobId: job._id,
      usageCount: 0,
      createdAt: Date.now(),
    });
    saved++;
    if (status === "APPROVED") approved++;
  }
  if (ownedRun) await refreshContentRun(ctx, ownedRun._id);
  return { saved, approved };
}

const pieceView = (
  p: Doc<"contentPieces">,
  extra: { magazineTitle?: string | null; productName?: string | null },
) => ({
  _id: p._id,
  channel: p.channel,
  caption: p.caption,
  hashtags: p.hashtags,
  script: p.script ?? null,
  mediaUrls: p.mediaUrls,
  qualityScore: p.qualityScore,
  qualityReport: p.qualityReport as {
    violations: { code: string; message: string; severity: string }[];
    fixed: string[];
  },
  status: p.status,
  visibility: p.visibility,
  generatedBy: p.generatedBy,
  runId: p.runId ?? null,
  productionMeta: p.productionMeta ?? null,
  usageCount: p.usageCount,
  createdAt: p.createdAt,
  mine: false,
  magazineTitle: extra.magazineTitle ?? null,
  productName: extra.productName ?? null,
  productId: p.productId ?? null,
});

async function decorate(
  ctx: QueryCtx | MutationCtx,
  rows: Doc<"contentPieces">[],
  viewerId: Id<"users">,
) {
  const out = [];
  for (const p of rows) {
    const m = p.magazineId ? await ctx.db.get(p.magazineId) : null;
    const pr = p.productId ? await ctx.db.get(p.productId) : null;
    out.push({
      ...pieceView(p, {
        magazineTitle: m?.title ?? null,
        productName: pr?.name ?? null,
      }),
      mine: p.ownerUserId === viewerId,
    });
  }
  return out;
}

/** 라이브러리: 내 조각 + 공유(SHARED) 조각. RETIRED 제외 */
const listLibraryArgs = {
    channel: v.optional(channelValidator),
    status: v.optional(v.union(v.literal("DRAFT"), v.literal("APPROVED"))),
    limit: v.optional(v.number()),
  };

export async function listLibraryFor(ctx: QueryCtx, user: Doc<"users">, args: ObjectType<typeof listLibraryArgs>) {
  const mine = await ctx.db
    .query("contentPieces")
    .withIndex("by_owner", (q) => q.eq("ownerUserId", user._id))
    .order("desc")
    .take(200);
  const shared = await ctx.db
    .query("contentPieces")
    .withIndex("by_visibility", (q) =>
      q.eq("visibility", "SHARED").eq("status", "APPROVED"),
    )
    .order("desc")
    .take(200);
  const merged = [
    ...mine,
    ...shared.filter((s) => s.ownerUserId !== user._id),
  ]
    .filter((p) => p.status !== "RETIRED")
    .filter((p) => !args.channel || p.channel === args.channel)
    .filter((p) => !args.status || p.status === args.status)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, Math.min(args.limit ?? 100, 300));
  return await decorate(ctx, merged, user._id);
}

export const listLibrary = query({
  args: listLibraryArgs,
  handler: async (ctx, args) => {
    return await listLibraryFor(ctx, await requireUser(ctx), args);
  },
});

const getPieceArgs = { pieceId: v.id("contentPieces") };

export async function getPieceFor(ctx: QueryCtx, user: Doc<"users">, args: ObjectType<typeof getPieceArgs>) {
  const p = await ctx.db.get(args.pieceId);
  if (!p) fail("NOT_FOUND", "콘텐츠를 찾을 수 없습니다.");
  if (
    p.ownerUserId !== user._id &&
    !(p.visibility === "SHARED" && p.status === "APPROVED") &&
    roleOf(user) !== "SUPER_ADMIN"
  )
    fail("FORBIDDEN", "접근할 수 없는 콘텐츠입니다.");
  return (await decorate(ctx, [p], user._id))[0]!;
}

export const getPiece = query({
  args: getPieceArgs,
  handler: async (ctx, args) => {
    return await getPieceFor(ctx, await requireUser(ctx), args);
  },
});

/** 유저가 직접 작성한 콘텐츠도 생성 결과와 같은 품질 게이트를 거쳐 저장한다. */
export const createManual = mutation({
  args: {
    channel: channelValidator,
    caption: v.string(),
    hashtags: v.array(v.string()),
    script: v.optional(v.string()),
    mediaUrls: v.array(v.string()),
    productId: v.optional(v.id("products")),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (args.productId && !(await ctx.db.get(args.productId))) fail("NOT_FOUND", "상품을 찾을 수 없습니다.");
    if (!args.caption.trim()) fail("INVALID_ARGUMENT", "본문을 입력하세요.");
    if (args.mediaUrls.length > 10) fail("INVALID_ARGUMENT", "미디어는 최대 10개까지 추가할 수 있습니다.");
    if (args.mediaUrls.some((url) => !/^https:\/\//i.test(url))) fail("INVALID_ARGUMENT", "미디어 URL은 HTTPS 주소만 사용할 수 있습니다.");
    const report = evaluatePiece({ channel: args.channel, caption: args.caption, hashtags: args.hashtags, script: args.script }, { linkExpected: true });
    const pieceId = await ctx.db.insert("contentPieces", {
      ownerUserId: user._id,
      visibility: "PRIVATE",
      productId: args.productId,
      channel: args.channel,
      caption: report.caption,
      hashtags: report.hashtags,
      script: args.script,
      mediaUrls: args.mediaUrls,
      qualityScore: report.score,
      qualityReport: { violations: report.violations, fixed: report.fixed },
      status: isAutoApprovable(report) ? "APPROVED" : "DRAFT",
      generatedBy: "manual",
      usageCount: 0,
      createdAt: Date.now(),
    });
    await audit(ctx, { actorUserId: user._id, action: "content.createManual", metadata: { pieceId, channel: args.channel } });
    return { pieceId, status: isAutoApprovable(report) ? "APPROVED" as const : "DRAFT" as const, score: report.score };
  },
});

/** 운영 제공 콘텐츠를 개인 사본으로 가져와 원본과 독립적으로 수정한다. */
export const copyToMine = mutation({
  args: { pieceId: v.id("contentPieces") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const source = await ctx.db.get(args.pieceId);
    if (!source || source.visibility !== "SHARED" || source.status !== "APPROVED") fail("NOT_FOUND", "공유 콘텐츠를 찾을 수 없습니다.");
    if (source.runId) {
      const run = await ctx.db.get(source.runId);
      const standardPassed = (source.productionMeta as { standardPassed?: boolean } | undefined)?.standardPassed === true;
      if (!standardPassed || run?.status !== "COMPLETED")
        fail("CONFLICT", "전체 제작 실행의 검수·승인이 완료되지 않은 콘텐츠는 가져올 수 없습니다.");
    }
    const pieceId = await ctx.db.insert("contentPieces", {
      ownerUserId: user._id,
      visibility: "PRIVATE",
      magazineId: source.magazineId,
      productId: source.productId,
      channel: source.channel,
      caption: source.caption,
      hashtags: source.hashtags,
      script: source.script,
      mediaUrls: source.mediaUrls,
      qualityScore: source.qualityScore,
      qualityReport: source.qualityReport,
      status: "APPROVED",
      generatedBy: "manual",
      usageCount: 0,
      createdAt: Date.now(),
    });
    await audit(ctx, { actorUserId: user._id, action: "content.copyToMine", metadata: { sourcePieceId: source._id, pieceId } });
    return { pieceId };
  },
});

async function productionContextForPiece(ctx: MutationCtx, piece: Doc<"contentPieces">) {
  if (!piece.runId) return null;
  const run = await ctx.db.get(piece.runId);
  if (!run) return null;
  const product = piece.productId ? await ctx.db.get(piece.productId) : null;
  const frozenProduct = piece.productId
    ? run.productSnapshots.find((snapshot) => snapshot.productId === piece.productId)
    : null;
  const meta = piece.productionMeta as { provider?: string } | undefined;
  return {
    run,
    brief: normalizeContentBrief(run.briefSnapshot as Partial<ContentProductionBrief>),
    standard: productionStandard(run.standardSnapshot),
    products: frozenProduct
      ? [{
          attrangsProductId: frozenProduct.attrangsProductId,
          name: frozenProduct.name,
          price: frozenProduct.price,
          salePrice: frozenProduct.salePrice,
          category: frozenProduct.category,
        }]
      : product ? [productBrief(product)] : [],
    provider: meta?.provider ?? piece.generatedBy,
  };
}

/** 발행/예약에서 조각을 사용할 때 호출: 접근 검사 + 사용 횟수 증가 후 본문·미디어 반환 */
export const approve = mutation({
  args: { pieceId: v.id("contentPieces") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const p = await ctx.db.get(args.pieceId);
    if (!p || (p.ownerUserId !== user._id && roleOf(user) !== "SUPER_ADMIN"))
      fail("NOT_FOUND", "콘텐츠를 찾을 수 없습니다.");
    const production = await productionContextForPiece(ctx, p);
    if (production) {
      const report = evaluatePiece({
        channel: p.channel as Channel,
        caption: p.caption,
        hashtags: p.hashtags,
        script: p.script ?? null,
      }, {
        linkExpected: true,
        products: production.products,
        brief: production.brief,
        standard: production.standard,
      });
      const standardPassed = isAutoApprovable(report)
        && passesContentStandard(report, production.provider, production.standard);
      if (!standardPassed)
        fail("CONFLICT", "금칙 또는 콘텐츠 제작 기준을 충족하지 못했습니다. 수정하거나 Codex로 다시 생성하세요.");
      const outputHash = await sha256Hex(canonicalJson({
        channel: p.channel,
        caption: report.caption,
        hashtags: report.hashtags,
        script: p.script ?? null,
        provider: production.provider,
        attemptNo: (p.productionMeta as { attemptNo?: number } | undefined)?.attemptNo ?? 1,
      }));
      await ctx.db.patch(p._id, {
        caption: report.caption,
        hashtags: report.hashtags,
        qualityScore: report.score,
        qualityReport: { violations: report.violations, fixed: report.fixed },
        status: "APPROVED",
        productionMeta: {
          ...(p.productionMeta as Record<string, unknown> | undefined),
          provider: production.provider,
          standardPassed: true,
          outputHash,
          humanApprovedAt: Date.now(),
          approvedByUserId: user._id,
          evaluatedAt: Date.now(),
        },
      });
      await refreshContentRun(ctx, production.run._id);
      return;
    }
    const blocks = (
      (p.qualityReport as { violations?: { severity: string }[] })
        ?.violations ?? []
    ).filter((v) => v.severity === "block");
    if (blocks.length > 0 && roleOf(user) !== "SUPER_ADMIN")
      fail("CONFLICT", "금칙 위반이 있는 콘텐츠는 수정 후 승인할 수 있습니다.");
    await ctx.db.patch(p._id, { status: "APPROVED" });
  },
});

export const edit = mutation({
  args: {
    pieceId: v.id("contentPieces"),
    caption: v.string(),
    hashtags: v.array(v.string()),
    script: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const p = await ctx.db.get(args.pieceId);
    if (!p || (p.ownerUserId !== user._id && roleOf(user) !== "SUPER_ADMIN"))
      fail("NOT_FOUND", "콘텐츠를 찾을 수 없습니다.");
    const production = await productionContextForPiece(ctx, p);
    const report = evaluatePiece(
      {
        channel: p.channel as Channel,
        caption: args.caption,
        hashtags: args.hashtags,
        script: args.script ?? null,
      },
      production
        ? {
            linkExpected: true,
            products: production.products,
            brief: production.brief,
            standard: production.standard,
          }
        : { linkExpected: true },
    );
    const standardPassed = production
      ? isAutoApprovable(report) && passesContentStandard(report, production.provider, production.standard)
      : isAutoApprovable(report);
    const outputHash = production
      ? await sha256Hex(canonicalJson({
          channel: p.channel,
          caption: report.caption,
          hashtags: report.hashtags,
          script: args.script ?? null,
          provider: production.provider,
          attemptNo: (p.productionMeta as { attemptNo?: number } | undefined)?.attemptNo ?? 1,
        }))
      : undefined;
    const nextStatus = production ? "DRAFT" as const : standardPassed ? "APPROVED" as const : "DRAFT" as const;
    await ctx.db.patch(p._id, {
      caption: report.caption,
      hashtags: report.hashtags,
      script: args.script,
      qualityScore: report.score,
      qualityReport: { violations: report.violations, fixed: report.fixed },
      status: nextStatus,
      generatedBy: production ? p.generatedBy : "manual",
      ...(production ? {
        productionMeta: {
          ...(p.productionMeta as Record<string, unknown> | undefined),
          provider: production.provider,
          standardPassed,
          outputHash,
          evaluatedAt: Date.now(),
          editedAt: Date.now(),
          editedByUserId: user._id,
          humanApprovedAt: null,
          approvedByUserId: null,
        },
      } : {}),
    });
    if (production) await refreshContentRun(ctx, production.run._id);
    return { score: report.score, violations: report.violations, status: nextStatus };
  },
});

export const reject = mutation({
  args: { pieceId: v.id("contentPieces"), reason: v.string() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const p = await ctx.db.get(args.pieceId);
    if (!p || (p.ownerUserId !== user._id && roleOf(user) !== "SUPER_ADMIN"))
      fail("NOT_FOUND", "콘텐츠를 찾을 수 없습니다.");
    await ctx.db.patch(p._id, { status: "RETIRED" });
    await ctx.db.insert("contentRejections", {
      userId: user._id,
      pieceId: p._id,
      channel: p.channel,
      reason: args.reason.trim().slice(0, 300),
      snippet: p.caption.slice(0, 200),
      createdAt: Date.now(),
    });
  },
});

/** 수퍼어드민: 공유 라이브러리 관리 */
export const setVisibility = mutation({
  args: {
    pieceId: v.id("contentPieces"),
    visibility: v.union(v.literal("PRIVATE"), v.literal("SHARED")),
  },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const p = await ctx.db.get(args.pieceId);
    if (!p) fail("NOT_FOUND", "콘텐츠를 찾을 수 없습니다.");
    if (args.visibility === "SHARED" && p.status !== "APPROVED")
      fail("CONFLICT", "승인된 콘텐츠만 공유할 수 있습니다.");
    if (args.visibility === "SHARED" && p.runId) {
      const run = await ctx.db.get(p.runId);
      const standardPassed = (p.productionMeta as { standardPassed?: boolean } | undefined)?.standardPassed === true;
      if (!standardPassed || run?.status !== "COMPLETED")
        fail("CONFLICT", "전체 실행의 검수·승인이 완료된 콘텐츠만 공유할 수 있습니다.");
    }
    await ctx.db.patch(p._id, { visibility: args.visibility });
    await audit(ctx, {
      actorUserId: actor._id,
      action: "content.setVisibility",
      metadata: { pieceId: p._id, visibility: args.visibility },
    });
  },
});

export const listAll = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const rows = await ctx.db
      .query("contentPieces")
      .order("desc")
      .take(Math.min(args.limit ?? 100, 500));
    return await decorate(ctx, rows, actor._id);
  },
});

export const rejectionStats = query({
  args: {},
  handler: async (ctx) => {
    await requireSuperAdmin(ctx);
    const rows = await ctx.db
      .query("contentRejections")
      .withIndex("by_createdAt")
      .order("desc")
      .take(200);
    const byReason = new Map<string, number>();
    for (const r of rows)
      byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
    return {
      total: rows.length,
      top: [...byReason.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([reason, count]) => ({ reason, count })),
      recent: rows.slice(0, 20),
    };
  },
});
