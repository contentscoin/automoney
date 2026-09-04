import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { audit } from "./lib/audit";
import { encryptField } from "./lib/crypto";
import { fail } from "./lib/errors";
import { requireSuperAdmin, requireUser } from "./lib/rbac";
import { kycStatusValidator } from "./schema";

const RESIDENT_NO = /^\d{6}-?\d{7}$/;
const ACCOUNT_NO = /^[\d-]{8,20}$/;
const PHONE = /^01[016789]-?\d{3,4}-?\d{4}$/;
const BIRTH = /^\d{4}-\d{2}-\d{2}$/;

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

const submitArgs = {
  legalName: v.string(),
  phone: v.string(),
  address: v.string(),
  birthDate: v.string(),
  residentNo: v.string(),
  bankCode: v.string(),
  bankName: v.string(),
  accountNo: v.string(),
  accountHolder: v.string(),
  bankbookStorageId: v.id("_storage"),
};

/** 액션: 민감 필드 암호화 후 내부 뮤테이션으로 저장. 평문은 DB 에 남지 않는다. */
export const submit = action({
  args: submitArgs,
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) fail("UNAUTHENTICATED", "로그인이 필요합니다.");
    const key = process.env.KYC_ENC_KEY;
    if (!key) fail("CONFIG_MISSING", "KYC_ENC_KEY 가 설정되지 않았습니다.");

    const legalName = args.legalName.trim();
    const phone = args.phone.replace(/\s/g, "");
    const residentNo = args.residentNo.replace(/\s/g, "");
    const accountNo = args.accountNo.replace(/\s/g, "");
    if (legalName.length < 2 || legalName.length > 30) fail("INVALID_ARGUMENT", "이름을 확인해 주세요.");
    if (!PHONE.test(phone)) fail("INVALID_ARGUMENT", "휴대폰 번호 형식이 올바르지 않습니다.");
    if (!BIRTH.test(args.birthDate)) fail("INVALID_ARGUMENT", "생년월일은 YYYY-MM-DD 형식입니다.");
    if (!RESIDENT_NO.test(residentNo)) fail("INVALID_ARGUMENT", "주민등록번호 형식이 올바르지 않습니다.");
    if (!ACCOUNT_NO.test(accountNo)) fail("INVALID_ARGUMENT", "계좌번호 형식이 올바르지 않습니다.");
    if (args.address.trim().length < 5) fail("INVALID_ARGUMENT", "주소를 입력해 주세요.");
    if (!args.bankCode.trim() || !args.bankName.trim()) fail("INVALID_ARGUMENT", "은행을 선택해 주세요.");
    if (args.accountHolder.trim().length < 2) fail("INVALID_ARGUMENT", "예금주를 입력해 주세요.");

    const residentDigits = residentNo.replace("-", "");
    const accountDigits = accountNo.replace(/-/g, "");
    const [residentNoEnc, accountNoEnc] = await Promise.all([
      encryptField(key, residentDigits),
      encryptField(key, accountDigits),
    ]);

    await ctx.runMutation(internal.kyc.saveSubmission, {
      userId,
      legalName,
      phone,
      address: args.address.trim(),
      birthDate: args.birthDate,
      residentNoEnc,
      residentNoLast4: residentDigits.slice(-4),
      bankCode: args.bankCode.trim(),
      bankName: args.bankName.trim(),
      accountNoEnc,
      accountNoLast4: accountDigits.slice(-4),
      accountHolder: args.accountHolder.trim(),
      bankbookStorageId: args.bankbookStorageId,
    });
    return { ok: true as const };
  },
});

export const saveSubmission = internalMutation({
  args: {
    userId: v.id("users"),
    legalName: v.string(),
    phone: v.string(),
    address: v.string(),
    birthDate: v.string(),
    residentNoEnc: v.string(),
    residentNoLast4: v.string(),
    bankCode: v.string(),
    bankName: v.string(),
    accountNoEnc: v.string(),
    accountNoLast4: v.string(),
    accountHolder: v.string(),
    bankbookStorageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const file = await ctx.db.system.get(args.bankbookStorageId);
    if (!file) fail("INVALID_ARGUMENT", "통장사본 파일을 찾을 수 없습니다.");
    if (file.size > 10 * 1024 * 1024) fail("INVALID_ARGUMENT", "통장사본은 10MB 이하여야 합니다.");
    if (file.contentType && !/^(image\/(jpeg|png|webp|heic)|application\/pdf)$/.test(file.contentType)) {
      fail("INVALID_ARGUMENT", "통장사본은 이미지 또는 PDF 만 가능합니다.");
    }
    const existing = await ctx.db
      .query("kycProfiles")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (existing?.status === "APPROVED") fail("CONFLICT", "이미 승인된 KYC 는 수정할 수 없습니다. 운영팀에 문의하세요.");
    const now = Date.now();
    const { userId, ...fields } = args;
    if (existing) {
      if (existing.bankbookStorageId !== args.bankbookStorageId) {
        await ctx.storage.delete(existing.bankbookStorageId);
      }
      await ctx.db.patch(existing._id, {
        ...fields,
        status: "SUBMITTED",
        submittedAt: now,
        reviewedAt: undefined,
        reviewedBy: undefined,
        rejectReason: undefined,
      });
    } else {
      await ctx.db.insert("kycProfiles", { userId, ...fields, status: "SUBMITTED", submittedAt: now });
    }
    await audit(ctx, { actorUserId: userId, targetUserId: userId, action: "kyc.submit" });
  },
});

/** 본인 KYC — 마스킹 필드만. */
export const getMine = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const row = await ctx.db
      .query("kycProfiles")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();
    if (!row) return null;
    return {
      status: row.status,
      legalName: row.legalName,
      phone: row.phone,
      address: row.address,
      birthDate: row.birthDate,
      residentNoMasked: `******-***${row.residentNoLast4}`,
      bankName: row.bankName,
      accountNoMasked: `****${row.accountNoLast4}`,
      accountHolder: row.accountHolder,
      submittedAt: row.submittedAt,
      reviewedAt: row.reviewedAt ?? null,
      rejectReason: row.rejectReason ?? null,
    };
  },
});

export const listQueue = query({
  args: { status: v.optional(kycStatusValidator) },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    const status = args.status ?? "SUBMITTED";
    const rows = await ctx.db
      .query("kycProfiles")
      .withIndex("by_status", (q) => q.eq("status", status))
      .order("desc")
      .take(200);
    const out = [];
    for (const r of rows) {
      const u = await ctx.db.get(r.userId);
      out.push({
        _id: r._id,
        userId: r.userId,
        email: u?.email ?? "",
        legalName: r.legalName,
        phone: r.phone,
        birthDate: r.birthDate,
        address: r.address,
        residentNoLast4: r.residentNoLast4,
        bankName: r.bankName,
        accountNoLast4: r.accountNoLast4,
        accountHolder: r.accountHolder,
        status: r.status,
        submittedAt: r.submittedAt,
        rejectReason: r.rejectReason ?? null,
      });
    }
    return out;
  },
});

/** 통장사본 열람 URL. 열람 자체를 감사로그에 남긴다. */
export const getBankbookUrl = mutation({
  args: { kycId: v.id("kycProfiles") },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const row = await ctx.db.get(args.kycId);
    if (!row) fail("NOT_FOUND", "KYC 를 찾을 수 없습니다.");
    await audit(ctx, { actorUserId: actor._id, targetUserId: row.userId, action: "kyc.viewBankbook" });
    return await ctx.storage.getUrl(row.bankbookStorageId);
  },
});

export const review = mutation({
  args: { kycId: v.id("kycProfiles"), decision: v.union(v.literal("APPROVED"), v.literal("REJECTED")), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const row = await ctx.db.get(args.kycId);
    if (!row) fail("NOT_FOUND", "KYC 를 찾을 수 없습니다.");
    if (args.decision === "REJECTED" && !args.reason?.trim()) fail("INVALID_ARGUMENT", "반려 사유를 입력하세요.");
    await ctx.db.patch(args.kycId, {
      status: args.decision,
      reviewedBy: actor._id,
      reviewedAt: Date.now(),
      rejectReason: args.decision === "REJECTED" ? args.reason?.trim() : undefined,
    });
    await audit(ctx, {
      actorUserId: actor._id,
      targetUserId: row.userId,
      action: `kyc.${args.decision.toLowerCase()}`,
      metadata: { reason: args.reason ?? null },
    });
  },
});

export type KycId = Id<"kycProfiles">;
