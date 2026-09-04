import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const roleValidator = v.union(v.literal("USER"), v.literal("ADMIN"), v.literal("SUPER_ADMIN"));
export const userStatusValidator = v.union(v.literal("PENDING"), v.literal("ACTIVE"), v.literal("SUSPENDED"));
export const kycStatusValidator = v.union(v.literal("SUBMITTED"), v.literal("APPROVED"), v.literal("REJECTED"));
export const orderStatusValidator = v.union(
  v.literal("PAID"),
  v.literal("CANCELLED"),
  v.literal("REFUNDED"),
  v.literal("CONFIRMED"),
);
export const attributionValidator = v.union(v.literal("DIRECT"), v.literal("INDIRECT"));
export const productStatusValidator = v.union(v.literal("ACTIVE"), v.literal("INACTIVE"));
export const linkStatusValidator = v.union(v.literal("ACTIVE"), v.literal("DISABLED"));

export default defineSchema({
  ...authTables,

  /** Convex Auth 기본 users 테이블 확장 (docs/02-data-model.md §2.1) */
  users: defineTable({
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    // automoney 확장
    role: v.optional(roleValidator),
    status: v.optional(userStatusValidator),
    parentAdminId: v.optional(v.id("users")),
    partnerCode: v.optional(v.string()),
    /** 가입 시 전달된 초대 코드. afterUserCreatedOrUpdated 에서 소비 후 제거. */
    inviteCode: v.optional(v.string()),
    userRateBpsOverride: v.optional(v.number()),
  })
    .index("email", ["email"])
    .index("phone", ["phone"])
    .index("by_parentAdmin", ["parentAdminId"])
    .index("by_partnerCode", ["partnerCode"])
    .index("by_role", ["role"]),

  inviteCodes: defineTable({
    code: v.string(),
    adminId: v.id("users"),
    maxUses: v.number(),
    usedCount: v.number(),
    expiresAt: v.optional(v.number()),
    active: v.boolean(),
  })
    .index("by_code", ["code"])
    .index("by_admin", ["adminId"]),

  kycProfiles: defineTable({
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
    status: kycStatusValidator,
    submittedAt: v.number(),
    reviewedBy: v.optional(v.id("users")),
    reviewedAt: v.optional(v.number()),
    rejectReason: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_status", ["status", "submittedAt"]),

  products: defineTable({
    attrangsProductId: v.number(),
    name: v.string(),
    price: v.number(),
    salePrice: v.optional(v.number()),
    category: v.optional(v.string()),
    imageUrls: v.array(v.string()),
    detailUrl: v.string(),
    status: productStatusValidator,
    syncedAt: v.number(),
    source: v.union(v.literal("CSV"), v.literal("MOCK"), v.literal("API")),
  })
    .index("by_attrangsProductId", ["attrangsProductId"])
    .index("by_status", ["status"])
    .searchIndex("search_name", { searchField: "name", filterFields: ["status"] }),

  marketingLinks: defineTable({
    userId: v.id("users"),
    productId: v.id("products"),
    trackingCode: v.string(),
    shortCode: v.string(),
    targetUrl: v.string(),
    status: linkStatusValidator,
    issuedAt: v.number(),
    clickCount: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_shortCode", ["shortCode"])
    .index("by_trackingCode", ["trackingCode"])
    .index("by_user_product", ["userId", "productId"]),

  clickEvents: defineTable({
    linkId: v.id("marketingLinks"),
    userId: v.id("users"),
    clickedAt: v.number(),
    ipHash: v.optional(v.string()),
    uaHash: v.optional(v.string()),
    referrerDomain: v.optional(v.string()),
    channel: v.optional(v.string()),
  })
    .index("by_link", ["linkId", "clickedAt"])
    .index("by_user", ["userId", "clickedAt"]),

  orders: defineTable({
    attrangsOrderId: v.string(),
    linkId: v.optional(v.id("marketingLinks")),
    userId: v.optional(v.id("users")),
    attribution: v.optional(attributionValidator),
    trackingCode: v.optional(v.string()),
    clickedAt: v.optional(v.number()),
    orderedAt: v.number(),
    landingProductId: v.optional(v.number()),
    quantity: v.number(),
    orderAmount: v.number(),
    commissionableAmount: v.number(),
    status: orderStatusValidator,
    rawPayload: v.any(),
    lastEventId: v.string(),
    updatedAt: v.number(),
  })
    .index("by_attrangsOrderId", ["attrangsOrderId"])
    .index("by_orderedAt", ["orderedAt"])
    .index("by_user", ["userId", "orderedAt"])
    .index("by_user_attribution", ["userId", "attribution", "orderedAt"]),

  orderEvents: defineTable({
    orderId: v.id("orders"),
    eventId: v.string(),
    eventType: v.string(),
    occurredAt: v.number(),
    payload: v.any(),
  })
    .index("by_order", ["orderId"])
    .index("by_eventId", ["eventId"]),

  /** 월별 유저 집계 (yyyy-mm, KST). 간접구매는 별도 필드로 분리해 유저 조회에서 제외한다. */
  userMonthlyStats: defineTable({
    userId: v.id("users"),
    month: v.string(),
    clicks: v.number(),
    directOrders: v.number(),
    directSales: v.number(),
    directCommissionable: v.number(),
    indirectOrders: v.number(),
    indirectSales: v.number(),
    indirectCommissionable: v.number(),
  })
    .index("by_user_month", ["userId", "month"])
    .index("by_month", ["month"]),

  /** 요율 규칙 (shared CommissionRule 계약) */
  commissionRules: defineTable({
    level: v.union(v.literal("ATTRANGS_TO_OPERATOR"), v.literal("OPERATOR_TO_ADMIN"), v.literal("ADMIN_TO_USER")),
    attribution: v.union(attributionValidator, v.literal("ANY")),
    grade: v.optional(v.string()),
    rateBps: v.number(),
    validFrom: v.number(),
    validTo: v.optional(v.number()),
    scopeUserId: v.optional(v.id("users")),
    scopeAdminId: v.optional(v.id("users")),
    active: v.boolean(),
    note: v.optional(v.string()),
  }).index("by_level", ["level", "active"]),

  gradeTiers: defineTable({
    grade: v.string(),
    minMonthlySales: v.number(),
    attrangsRateBps: v.number(),
    active: v.boolean(),
  }).index("by_grade", ["grade"]),

  /** 주문별 3단계 분배 결과. sign=-1 은 취소·반품 역분개. 결정론적 재계산 가능. */
  commissionEntries: defineTable({
    orderId: v.id("orders"),
    month: v.string(),
    beneficiaryType: v.union(v.literal("USER"), v.literal("ADMIN"), v.literal("OPERATOR")),
    beneficiaryUserId: v.optional(v.id("users")),
    attribution: attributionValidator,
    rateBps: v.number(),
    baseAmount: v.number(),
    amount: v.number(),
    sign: v.number(),
    grade: v.string(),
    provisional: v.boolean(),
    computationVersion: v.number(),
    settlementId: v.optional(v.id("settlements")),
    createdAt: v.number(),
  })
    .index("by_order", ["orderId"])
    .index("by_beneficiary_month", ["beneficiaryUserId", "month"])
    .index("by_type_month", ["beneficiaryType", "month"])
    .index("by_month", ["month"])
    .index("by_settlement", ["settlementId"]),

  settlements: defineTable({
    month: v.string(),
    beneficiaryType: v.union(v.literal("USER"), v.literal("ADMIN"), v.literal("OPERATOR")),
    beneficiaryUserId: v.optional(v.id("users")),
    status: v.union(v.literal("DRAFT"), v.literal("CONFIRMED"), v.literal("APPROVED"), v.literal("PAID"), v.literal("HELD")),
    grossAmount: v.number(),
    entryCount: v.number(),
    heldReason: v.optional(v.string()),
    confirmedAt: v.optional(v.number()),
    approvedAt: v.optional(v.number()),
    paidAt: v.optional(v.number()),
    paidRef: v.optional(v.string()),
    payoutFileGeneratedAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_month", ["month"])
    .index("by_beneficiary", ["beneficiaryUserId", "month"])
    .index("by_month_type", ["month", "beneficiaryType"]),

  /** 아뜨랑스 월 정산 확정 배치 원본 + 리컨실 결과 */
  attrangsSettlementBatches: defineTable({
    month: v.string(),
    grade: v.string(),
    rateBps: v.number(),
    payoutTotal: v.number(),
    orders: v.array(
      v.object({
        orderId: v.string(),
        commissionableAmount: v.number(),
        attribution: attributionValidator,
        status: v.union(v.literal("CONFIRMED"), v.literal("CANCELLED"), v.literal("REFUNDED")),
      }),
    ),
    uploadedBy: v.id("users"),
    uploadedAt: v.number(),
    reconciledAt: v.optional(v.number()),
    diffAmount: v.optional(v.number()),
    diffs: v.optional(v.array(v.object({ kind: v.string(), orderId: v.string(), detail: v.string() }))),
    ourOperatorTotal: v.optional(v.number()),
  }).index("by_month", ["month"]),

  /** 월별 마감 메타 (그레이드 확정값·계산 버전) */
  settlementMonths: defineTable({
    month: v.string(),
    grade: v.string(),
    gradeSource: v.union(v.literal("PROVISIONAL"), v.literal("ATTRANGS")),
    computationVersion: v.number(),
    closedAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_month", ["month"]),

  settings: defineTable({
    key: v.string(),
    value: v.any(),
    updatedBy: v.optional(v.id("users")),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  auditEvents: defineTable({
    actorUserId: v.optional(v.id("users")),
    targetUserId: v.optional(v.id("users")),
    action: v.string(),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
  })
    .index("by_createdAt", ["createdAt"])
    .index("by_target", ["targetUserId", "createdAt"]),
});
