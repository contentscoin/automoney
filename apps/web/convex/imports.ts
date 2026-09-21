import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { requireSuperAdmin } from "./lib/rbac";
import { fail } from "./lib/errors";
import { canonicalJson } from "./jobs";
import { sha256Hex } from "./lib/crypto";
import { audit } from "./lib/audit";
import { parseProductCsv } from "@automoney/shared";
import { upsertProducts } from "./products";
import { ingestOrderPayload } from "./orders";

function csvCells(line: string): string[] {
  const out: string[] = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"' && quoted && line[i + 1] === '"') { value += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (c === "," && !quoted) { out.push(value.trim()); value = ""; }
    else value += c;
  }
  out.push(value.trim());
  return out;
}

export const previewLinkPool = mutation({
  args: { csv: v.string(), sourceVersion: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    if (args.csv.length > 2_000_000) fail("INVALID_ARGUMENT", "CSV 는 2MB 이하여야 합니다.");
    const text = args.csv.replace(/^\uFEFF/, "").replace(/\r/g, "");
    const lines = text.split("\n").filter((line) => line.trim());
    if (lines.length < 2 || lines.length > 5001) fail("INVALID_ARGUMENT", "헤더와 1~5000개 데이터 행이 필요합니다.");
    const headers = csvCells(lines[0]!).map((h) => h.toLowerCase());
    const required = ["external_product_id", "tracking_code", "target_url"];
    if (required.some((h) => !headers.includes(h))) fail("INVALID_ARGUMENT", `필수 헤더: ${required.join(",")}`);
    const contentHash = await sha256Hex(text);
    const duplicate = await ctx.db.query("importBatches").withIndex("by_kind_hash", (q) => q.eq("kind", "LINK_POOL").eq("contentHash", contentHash)).unique();
    if (duplicate) return { batchId: duplicate._id, duplicate: true, totalRows: duplicate.totalRows, validRows: duplicate.validRows, errorRows: duplicate.errorRows, status: duplicate.status };
    const parsed = [];
    let validRows = 0;
    for (let index = 1; index < lines.length; index++) {
      const values = csvCells(lines[index]!);
      const get = (name: string) => values[headers.indexOf(name)] ?? "";
      const product = Number(get("external_product_id"));
      const trackingCode = get("tracking_code");
      const targetUrl = get("target_url");
      const errors: string[] = [];
      if (!Number.isSafeInteger(product) || product <= 0) errors.push("external_product_id invalid");
      if (!/^[A-Za-z0-9._-]{3,128}$/.test(trackingCode)) errors.push("tracking_code invalid");
      try { if (new URL(targetUrl).protocol !== "https:") errors.push("target_url must use https"); } catch { errors.push("target_url invalid"); }
      const normalizedPayload = { externalProductId: product, trackingCode, targetUrl };
      if (errors.length === 0) validRows++;
      parsed.push({ rowNo: index + 1, normalizedPayload, rowHash: await sha256Hex(canonicalJson(normalizedPayload)), errors });
    }
    const batchId = await ctx.db.insert("importBatches", { kind: "LINK_POOL", contentHash, sourceVersion: args.sourceVersion, uploadedBy: actor._id, status: parsed.every((r) => r.errors.length === 0) ? "VALIDATED" : "PREVIEW", totalRows: parsed.length, validRows, appliedRows: 0, errorRows: parsed.length - validRows, cursor: 0, createdAt: Date.now() });
    for (const row of parsed) await ctx.db.insert("importRows", { batchId, ...row, status: row.errors.length === 0 ? "VALID" : "INVALID" });
    await audit(ctx, { actorUserId: actor._id, action: "imports.previewLinkPool", metadata: { batchId, rows: parsed.length, errors: parsed.length - validRows } });
    return { batchId, duplicate: false, totalRows: parsed.length, validRows, errorRows: parsed.length - validRows, status: parsed.every((r) => r.errors.length === 0) ? "VALIDATED" as const : "PREVIEW" as const };
  },
});

export const applyLinkPool = mutation({
  args: { batchId: v.id("importBatches") },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const batch = await ctx.db.get(args.batchId);
    if (!batch || batch.kind !== "LINK_POOL") fail("NOT_FOUND", "링크 풀 배치를 찾을 수 없습니다.");
    if (batch.errorRows > 0) fail("CONFLICT", "오류 행이 있는 배치는 적용할 수 없습니다.");
    if (batch.status === "COMPLETED") return { completed: true, applied: 0, cursor: batch.cursor ?? batch.totalRows };
    const rows = await ctx.db.query("importRows").withIndex("by_batch_row", (q) => q.eq("batchId", batch._id).gt("rowNo", batch.cursor ?? 0)).take(100);
    let applied = 0;
    let cursor = batch.cursor ?? 0;
    for (const row of rows) {
      cursor = row.rowNo;
      if (row.status === "APPLIED") continue;
      const data = row.normalizedPayload as { externalProductId: number; trackingCode: string; targetUrl: string };
      const product = await ctx.db.query("products").withIndex("by_attrangsProductId", (q) => q.eq("attrangsProductId", data.externalProductId)).unique();
      if (!product) { await ctx.db.patch(row._id, { status: "INVALID", errors: ["product not found"] }); fail("CONFLICT", `상품 ${data.externalProductId} 이 없습니다.`); }
      const existing = await ctx.db.query("partnerLinkPool").withIndex("by_trackingCode", (q) => q.eq("trackingCode", data.trackingCode)).unique();
      if (!existing) { await ctx.db.insert("partnerLinkPool", { productId: product._id, trackingCode: data.trackingCode, targetUrl: data.targetUrl, status: "AVAILABLE", batchId: batch._id }); applied++; }
      await ctx.db.patch(row._id, { status: existing ? "SKIPPED" : "APPLIED" });
    }
    const completed = cursor >= batch.totalRows;
    await ctx.db.patch(batch._id, { status: completed ? "COMPLETED" : "APPLYING", cursor, appliedRows: batch.appliedRows + applied, ...(completed ? { completedAt: Date.now() } : {}) });
    await audit(ctx, { actorUserId: actor._id, action: "imports.applyLinkPool", metadata: { batchId: batch._id, applied, cursor, completed } });
    return { completed, applied, cursor };
  },
});

export const previewProducts = mutation({
  args: { csv: v.string(), sourceVersion: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    if (args.csv.length > 2_000_000) fail("INVALID_ARGUMENT", "CSV 는 2MB 이하여야 합니다.");
    const contentHash = await sha256Hex(args.csv.replace(/^\uFEFF/, ""));
    const duplicate = await ctx.db.query("importBatches").withIndex("by_kind_hash", (q) => q.eq("kind", "PRODUCT").eq("contentHash", contentHash)).unique();
    if (duplicate) return { batchId: duplicate._id, duplicate: true, totalRows: duplicate.totalRows, validRows: duplicate.validRows, errorRows: duplicate.errorRows, status: duplicate.status };
    const parsed = parseProductCsv(args.csv);
    if (parsed.rows.length + parsed.errors.length > 5000) fail("INVALID_ARGUMENT", "상품 CSV 는 5,000행 이하여야 합니다.");
    const totalRows = parsed.rows.length + parsed.errors.length;
    const batchId = await ctx.db.insert("importBatches", { kind: "PRODUCT", contentHash, sourceVersion: args.sourceVersion, uploadedBy: actor._id, status: parsed.errors.length ? "PREVIEW" : "VALIDATED", totalRows, validRows: parsed.rows.length, appliedRows: 0, errorRows: parsed.errors.length, cursor: 0, createdAt: Date.now() });
    let rowNo = 2;
    for (const product of parsed.rows) {
      await ctx.db.insert("importRows", { batchId, rowNo, normalizedPayload: product, rowHash: await sha256Hex(canonicalJson(product)), status: "VALID", errors: [] });
      rowNo++;
    }
    for (const error of parsed.errors) {
      await ctx.db.insert("importRows", { batchId, rowNo, normalizedPayload: {}, rowHash: await sha256Hex(`${rowNo}:${error}`), status: "INVALID", errors: [error] });
      rowNo++;
    }
    await audit(ctx, { actorUserId: actor._id, action: "imports.previewProducts", metadata: { batchId, totalRows, errors: parsed.errors.length } });
    return { batchId, duplicate: false, totalRows, validRows: parsed.rows.length, errorRows: parsed.errors.length, status: parsed.errors.length ? "PREVIEW" as const : "VALIDATED" as const };
  },
});

export const applyProducts = mutation({
  args: { batchId: v.id("importBatches") },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const batch = await ctx.db.get(args.batchId);
    if (!batch || batch.kind !== "PRODUCT") fail("NOT_FOUND", "상품 배치를 찾을 수 없습니다.");
    if (batch.errorRows > 0) fail("CONFLICT", "오류 행이 있는 배치는 적용할 수 없습니다.");
    if (batch.status === "COMPLETED") return { completed: true, applied: 0, cursor: batch.cursor ?? batch.totalRows };
    const rows = await ctx.db.query("importRows").withIndex("by_batch_row", (q) => q.eq("batchId", batch._id).gt("rowNo", batch.cursor ?? 0)).take(100);
    const products = rows.filter((row) => row.status === "VALID").map((row) => row.normalizedPayload) as Parameters<typeof upsertProducts>[1];
    await upsertProducts(ctx, products, "CSV");
    let cursor = batch.cursor ?? 0;
    for (const row of rows) { cursor = row.rowNo; await ctx.db.patch(row._id, { status: row.status === "VALID" ? "APPLIED" : row.status }); }
    const completed = cursor >= batch.totalRows + 1;
    await ctx.db.patch(batch._id, { status: completed ? "COMPLETED" : "APPLYING", cursor, appliedRows: batch.appliedRows + products.length, ...(completed ? { completedAt: Date.now() } : {}) });
    await audit(ctx, { actorUserId: actor._id, action: "imports.applyProducts", metadata: { batchId: batch._id, applied: products.length, cursor, completed } });
    return { completed, applied: products.length, cursor };
  },
});

export const previewOrders = mutation({
  args: { csv: v.string(), sourceVersion: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    if (args.csv.length > 2_000_000) fail("INVALID_ARGUMENT", "CSV 는 2MB 이하여야 합니다.");
    const text = args.csv.replace(/^\uFEFF/, "").replace(/\r/g, "");
    const lines = text.split("\n").filter((line) => line.trim());
    if (lines.length < 2 || lines.length > 5001) fail("INVALID_ARGUMENT", "헤더와 1~5000개 데이터 행이 필요합니다.");
    const headers = csvCells(lines[0]!).map((h) => h.toLowerCase());
    const required = ["event_id", "event_type", "occurred_at", "order_id", "ordered_at", "tracking_code", "attribution", "order_amount", "commissionable_amount", "status"];
    if (required.some((h) => !headers.includes(h))) fail("INVALID_ARGUMENT", `필수 헤더: ${required.join(",")}`);
    const contentHash = await sha256Hex(text);
    const duplicate = await ctx.db.query("importBatches").withIndex("by_kind_hash", (q) => q.eq("kind", "ORDER").eq("contentHash", contentHash)).unique();
    if (duplicate) return { batchId: duplicate._id, duplicate: true, totalRows: duplicate.totalRows, validRows: duplicate.validRows, errorRows: duplicate.errorRows, status: duplicate.status };
    const parsed: { rowNo: number; normalizedPayload: unknown; rowHash: string; errors: string[] }[] = [];
    for (let index = 1; index < lines.length; index++) {
      const values = csvCells(lines[index]!);
      const get = (name: string) => values[headers.indexOf(name)] ?? "";
      const errors: string[] = [];
      const orderAmount = Number(get("order_amount"));
      const commissionableAmount = Number(get("commissionable_amount"));
      const attribution = get("attribution").toLowerCase();
      const status = get("status").toLowerCase();
      const occurredAt = get("occurred_at");
      const orderedAt = get("ordered_at");
      if (!get("event_id") || !get("order_id")) errors.push("event_id/order_id required");
      if (!Number.isFinite(Date.parse(occurredAt)) || !Number.isFinite(Date.parse(orderedAt))) errors.push("date invalid");
      if (!Number.isSafeInteger(orderAmount) || !Number.isSafeInteger(commissionableAmount) || orderAmount < 0 || commissionableAmount < 0) errors.push("amount invalid");
      if (!['direct', 'indirect', ''].includes(attribution)) errors.push("attribution invalid");
      if (!['paid', 'confirmed', 'cancelled', 'refunded'].includes(status)) errors.push("status invalid");
      const clickedAt = get("clicked_at") || null;
      if (clickedAt && !Number.isFinite(Date.parse(clickedAt))) errors.push("clicked_at invalid");
      const payload = {
        event_id: get("event_id"), event_type: get("event_type"), occurred_at: occurredAt, ...(get("source_version") || args.sourceVersion ? { source_version: get("source_version") || args.sourceVersion } : {}),
        order: { order_id: get("order_id"), ordered_at: orderedAt, tracking_code: get("tracking_code") || null, attribution: attribution || null, clicked_at: clickedAt, landing_product_id: null, items: [{ product_id: 0, qty: 1, amount: orderAmount, commissionable_amount: commissionableAmount }], order_amount: orderAmount, commissionable_amount: commissionableAmount, status },
      };
      parsed.push({ rowNo: index + 1, normalizedPayload: payload, rowHash: await sha256Hex(canonicalJson(payload)), errors });
    }
    const validRows = parsed.filter((row) => row.errors.length === 0).length;
    const batchId = await ctx.db.insert("importBatches", { kind: "ORDER", contentHash, sourceVersion: args.sourceVersion, uploadedBy: actor._id, status: validRows === parsed.length ? "VALIDATED" : "PREVIEW", totalRows: parsed.length, validRows, appliedRows: 0, errorRows: parsed.length - validRows, cursor: 0, createdAt: Date.now() });
    for (const row of parsed) await ctx.db.insert("importRows", { batchId, ...row, status: row.errors.length ? "INVALID" : "VALID" });
    await audit(ctx, { actorUserId: actor._id, action: "imports.previewOrders", metadata: { batchId, rows: parsed.length, errors: parsed.length - validRows } });
    return { batchId, duplicate: false, totalRows: parsed.length, validRows, errorRows: parsed.length - validRows, status: validRows === parsed.length ? "VALIDATED" as const : "PREVIEW" as const };
  },
});

export const applyOrders = mutation({
  args: { batchId: v.id("importBatches") },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const batch = await ctx.db.get(args.batchId);
    if (!batch || batch.kind !== "ORDER") fail("NOT_FOUND", "주문 배치를 찾을 수 없습니다.");
    if (batch.errorRows > 0 && batch.status !== "APPLYING") fail("CONFLICT", "미리보기 오류를 먼저 수정하세요.");
    if (batch.status === "COMPLETED") return { completed: true, applied: 0, quarantined: 0, cursor: batch.cursor ?? batch.totalRows };
    const rows = await ctx.db.query("importRows").withIndex("by_batch_row", (q) => q.eq("batchId", batch._id).gt("rowNo", batch.cursor ?? 0)).take(100);
    let cursor = batch.cursor ?? 0; let applied = 0; let quarantined = 0;
    for (const row of rows) {
      cursor = row.rowNo;
      if (row.status !== "VALID") continue;
      const result = await ingestOrderPayload(ctx, row.normalizedPayload, "CSV");
      if (result.accepted) { applied++; await ctx.db.patch(row._id, { status: result.duplicate ? "SKIPPED" : "APPLIED" }); }
      else { quarantined++; await ctx.db.patch(row._id, { status: "INVALID", errors: [result.reason] }); }
    }
    const completed = cursor >= batch.totalRows + 1;
    await ctx.db.patch(batch._id, { status: completed ? (quarantined ? "FAILED" : "COMPLETED") : "APPLYING", cursor, appliedRows: batch.appliedRows + applied, errorRows: batch.errorRows + quarantined, ...(completed ? { completedAt: Date.now() } : {}) });
    await audit(ctx, { actorUserId: actor._id, action: "imports.applyOrders", metadata: { batchId: batch._id, applied, quarantined, cursor, completed } });
    return { completed, applied, quarantined, cursor };
  },
});
