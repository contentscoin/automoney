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

  // ─────────────── M3: 디바이스 · 스페이스 · 잡큐 · 예약 · 텔레그램 ───────────────
  devices: defineTable({
    userId: v.id("users"),
    name: v.string(),
    platform: v.string(),
    appVersion: v.string(),
    tokenHash: v.string(),
    status: v.union(v.literal("ACTIVE"), v.literal("REVOKED"), v.literal("REPLACED")),
    pairedAt: v.number(),
    lastSeenAt: v.optional(v.number()),
    snapshot: v.optional(v.any()),
  })
    .index("by_user", ["userId", "status"])
    .index("by_tokenHash", ["tokenHash"]),

  pairCodes: defineTable({
    userId: v.id("users"),
    codeHash: v.string(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
  })
    .index("by_codeHash", ["codeHash"])
    .index("by_user", ["userId"]),

  spaces: defineTable({
    userId: v.id("users"),
    deviceId: v.optional(v.id("devices")),
    platform: v.union(v.literal("THREADS"), v.literal("X"), v.literal("INSTAGRAM"), v.literal("TIKTOK"), v.literal("NAVER_BLOG")),
    name: v.string(),
    handle: v.optional(v.string()),
    pinned: v.boolean(),
    fingerprint: v.optional(v.any()),
    sessionState: v.union(
      v.literal("CREATED"),
      v.literal("LOGIN_REQUIRED"),
      v.literal("HEALTHY"),
      v.literal("RUNNING"),
      v.literal("EXPIRED"),
      v.literal("RESTRICTED"),
      v.literal("PAUSED"),
    ),
    dailyPostLimit: v.number(),
    lastCheckedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    lockJobId: v.optional(v.id("agentJobs")),
    authMode: v.optional(v.union(v.literal("BROWSER"), v.literal("META_API"))),
    snsAccountId: v.optional(v.id("snsAccounts")),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_device", ["deviceId"]),

  agentJobs: defineTable({
    userId: v.id("users"),
    deviceId: v.optional(v.id("devices")),
    spaceId: v.optional(v.id("spaces")),
    scheduleId: v.optional(v.id("schedules")),
    jobType: v.union(v.literal("post.publish"), v.literal("space.create"), v.literal("space.login"), v.literal("space.verify"), v.literal("codex.login"), v.literal("content.generate"), v.literal("post.readback"), v.literal("meta.token_refresh")),
    executor: v.optional(v.union(v.literal("DESKTOP"), v.literal("CLOUD"))),
    fallbackFromJobId: v.optional(v.id("agentJobs")),
    payload: v.any(),
    status: v.union(
      v.literal("NEEDS_APPROVAL"),
      v.literal("QUEUED"),
      v.literal("RUNNING"),
      v.literal("SUCCEEDED"),
      v.literal("FAILED"),
      v.literal("CANCELLED"),
    ),
    runAfter: v.number(),
    idempotencyKey: v.optional(v.string()),
    claimedByDeviceId: v.optional(v.id("devices")),
    leaseUntil: v.optional(v.number()),
    heartbeatAt: v.optional(v.number()),
    stage: v.optional(v.string()),
    progress: v.optional(v.number()),
    cancelRequested: v.boolean(),
    result: v.optional(v.any()),
    errorCode: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    source: v.union(v.literal("WEB"), v.literal("SCHEDULE"), v.literal("TELEGRAM"), v.literal("MCP"), v.literal("SYSTEM")),
    createdAt: v.number(),
    updatedAt: v.number(),
    finishedAt: v.optional(v.number()),
  })
    .index("by_user_status", ["userId", "status", "runAfter"])
    .index("by_user", ["userId", "createdAt"])
    .index("by_status", ["status", "runAfter"])
    .index("by_idempotencyKey", ["idempotencyKey"])
    .index("by_space", ["spaceId", "createdAt"]),

  schedules: defineTable({
    userId: v.id("users"),
    spaceId: v.id("spaces"),
    kind: v.union(v.literal("ONE_SHOT"), v.literal("DAILY"), v.literal("WEEKLY")),
    timeOfDay: v.string(),
    daysOfWeek: v.array(v.number()),
    runDate: v.optional(v.string()),
    jitterMinutes: v.number(),
    text: v.string(),
    mediaUrls: v.array(v.string()),
    linkId: v.optional(v.id("marketingLinks")),
    pieceId: v.optional(v.id("contentPieces")),
    autoApprove: v.boolean(),
    enabled: v.boolean(),
    nextRunAt: v.optional(v.number()),
    lastRunAt: v.optional(v.number()),
    lastJobId: v.optional(v.id("agentJobs")),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_enabled_next", ["enabled", "nextRunAt"]),

  telegramBindings: defineTable({
    userId: v.id("users"),
    chatId: v.optional(v.string()),
    bindCodeHash: v.optional(v.string()),
    bindCodeExpiresAt: v.optional(v.number()),
    boundAt: v.optional(v.number()),
    notify: v.boolean(),
  })
    .index("by_user", ["userId"])
    .index("by_chatId", ["chatId"])
    .index("by_bindCodeHash", ["bindCodeHash"]),

  telegramOutbox: defineTable({
    userId: v.optional(v.id("users")),
    chatId: v.string(),
    text: v.string(),
    status: v.union(v.literal("SENT"), v.literal("SKIPPED_NO_TOKEN"), v.literal("FAILED")),
    detail: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_user", ["userId", "createdAt"]),

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

  // ---- M4 콘텐츠 엔진 · 큐레이션 ----
  magazines: defineTable({
    sourceUrl: v.optional(v.string()),
    title: v.string(),
    description: v.optional(v.string()),
    heroImage: v.optional(v.string()),
    imageUrls: v.array(v.string()),
    bodyText: v.string(),
    attrangsProductIds: v.array(v.number()),
    productIds: v.array(v.id("products")),
    publishedAt: v.optional(v.number()),
    ingestedAt: v.number(),
    createdBy: v.id("users"),
    atomCount: v.number(),
    status: v.union(v.literal("ACTIVE"), v.literal("ARCHIVED")),
  })
    .index("by_status", ["status", "publishedAt"])
    .index("by_sourceUrl", ["sourceUrl"]),

  contentAtoms: defineTable({
    magazineId: v.id("magazines"),
    atomType: v.union(
      v.literal("HOOK"),
      v.literal("STYLE_TIP"),
      v.literal("PRODUCT_POINT"),
      v.literal("QUOTE"),
      v.literal("TREND_TIE_IN"),
    ),
    text: v.string(),
    attrangsProductId: v.optional(v.number()),
    rank: v.number(),
  }).index("by_magazine", ["magazineId", "rank"]),

  contentPieces: defineTable({
    ownerUserId: v.optional(v.id("users")),
    visibility: v.union(v.literal("PRIVATE"), v.literal("SHARED")),
    magazineId: v.optional(v.id("magazines")),
    productId: v.optional(v.id("products")),
    channel: v.union(
      v.literal("INSTAGRAM_FEED"),
      v.literal("INSTAGRAM_REEL"),
      v.literal("THREADS"),
      v.literal("X"),
      v.literal("TIKTOK"),
      v.literal("BLOG"),
    ),
    caption: v.string(),
    hashtags: v.array(v.string()),
    script: v.optional(v.string()),
    mediaUrls: v.array(v.string()),
    qualityScore: v.number(),
    qualityReport: v.any(),
    status: v.union(
      v.literal("DRAFT"),
      v.literal("APPROVED"),
      v.literal("RETIRED"),
    ),
    generatedBy: v.union(
      v.literal("codex"),
      v.literal("template"),
      v.literal("manual"),
    ),
    jobId: v.optional(v.id("agentJobs")),
    usageCount: v.number(),
    createdAt: v.number(),
  })
    .index("by_owner", ["ownerUserId", "createdAt"])
    .index("by_visibility", ["visibility", "status", "createdAt"])
    .index("by_job", ["jobId"]),

  curationItems: defineTable({
    kind: v.union(
      v.literal("MEME"),
      v.literal("TREND"),
      v.literal("PRODUCT_FACT"),
      v.literal("CELEB_MATCH"),
    ),
    title: v.string(),
    body: v.optional(v.string()),
    sourceUrl: v.optional(v.string()),
    mediaUrl: v.optional(v.string()),
    productId: v.optional(v.id("products")),
    licenseNote: v.optional(v.string()),
    score: v.number(),
    source: v.string(),
    dedupeKey: v.string(),
    fetchedAt: v.number(),
    expiresAt: v.optional(v.number()),
    status: v.union(v.literal("ACTIVE"), v.literal("HIDDEN")),
  })
    .index("by_kind", ["kind", "status", "score"])
    .index("by_product", ["productId", "kind"])
    .index("by_dedupeKey", ["dedupeKey"]),

  contentRejections: defineTable({
    userId: v.id("users"),
    pieceId: v.optional(v.id("contentPieces")),
    channel: v.string(),
    reason: v.string(),
    snippet: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_createdAt", ["createdAt"])
    .index("by_user", ["userId", "createdAt"]),

  // ---- M5 Stateless MCP ----
  mcpCredentials: defineTable({
    userId: v.id("users"),
    endpointId: v.string(),
    secretHash: v.string(),
    keyHash: v.string(),
    label: v.string(),
    scopes: v.array(v.string()),
    status: v.union(v.literal("ACTIVE"), v.literal("REVOKED")),
    lastUsedAt: v.optional(v.number()),
    callCount: v.number(),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
    // OAuth 로 발급된 경우: kind=OAUTH, keyHash 가 액세스 토큰, expiresAt 만료(리프레시로 회전)
    kind: v.optional(v.union(v.literal("API_KEY"), v.literal("OAUTH"))),
    clientId: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
  })
    .index("by_user", ["userId", "createdAt"])
    .index("by_endpointId", ["endpointId"])
    .index("by_keyHash", ["keyHash"]),

  // ---- MCP OAuth 2.1 (동적 클라이언트 등록 · PKCE · 리프레시 회전) ----
  oauthClients: defineTable({
    clientId: v.string(),
    clientName: v.string(),
    redirectUris: v.array(v.string()),
    tokenEndpointAuthMethod: v.union(v.literal("none"), v.literal("client_secret_post")),
    clientSecretHash: v.optional(v.string()),
    clientUri: v.optional(v.string()),
    logoUri: v.optional(v.string()),
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
  }).index("by_clientId", ["clientId"]),

  oauthCodes: defineTable({
    codeHash: v.string(),
    clientId: v.string(),
    userId: v.id("users"),
    redirectUri: v.string(),
    scopes: v.array(v.string()),
    codeChallenge: v.string(),
    resource: v.optional(v.string()),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_codeHash", ["codeHash"]),

  oauthRefreshTokens: defineTable({
    tokenHash: v.string(),
    credentialId: v.id("mcpCredentials"),
    clientId: v.string(),
    userId: v.id("users"),
    status: v.union(v.literal("ACTIVE"), v.literal("ROTATED"), v.literal("REVOKED")),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_credential", ["credentialId"]),

  mcpRateBuckets: defineTable({
    key: v.string(),
    windowStart: v.number(),
    count: v.number(),
  }).index("by_key", ["key"]),

  // ---- M5 Meta API 계정 ----
  snsAccounts: defineTable({
    userId: v.id("users"),
    platform: v.union(v.literal("THREADS"), v.literal("INSTAGRAM")),
    providerUserId: v.string(),
    username: v.optional(v.string()),
    tokenEnc: v.string(),
    tokenExpiresAt: v.number(),
    scopes: v.array(v.string()),
    status: v.union(v.literal("ACTIVE"), v.literal("EXPIRED"), v.literal("REVOKED")),
    spaceId: v.optional(v.id("spaces")),
    mode: v.union(v.literal("mock"), v.literal("graph")),
    lastError: v.optional(v.string()),
    lastRefreshedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_user", ["userId", "platform"])
    .index("by_status_expiry", ["status", "tokenExpiresAt"]),

  metaOauthStates: defineTable({
    userId: v.id("users"),
    platform: v.union(v.literal("THREADS"), v.literal("INSTAGRAM")),
    state: v.string(),
    expiresAt: v.number(),
  }).index("by_state", ["state"]),

  // ---- M5 분석 루프 ----
  postMetrics: defineTable({
    jobId: v.id("agentJobs"),
    userId: v.id("users"),
    spaceId: v.optional(v.id("spaces")),
    snsAccountId: v.optional(v.id("snsAccounts")),
    platform: v.string(),
    channel: v.string(),
    postUrl: v.string(),
    externalPostId: v.optional(v.string()),
    pieceId: v.optional(v.id("contentPieces")),
    linkId: v.optional(v.id("marketingLinks")),
    hookType: v.string(),
    ctaType: v.string(),
    hourKst: v.number(),
    postedAt: v.number(),
    snapshots: v.array(
      v.object({
        window: v.union(v.literal("24h"), v.literal("72h"), v.literal("7d")),
        at: v.number(),
        source: v.union(v.literal("META_API"), v.literal("BROWSER"), v.literal("LEDGER")),
        impressions: v.optional(v.number()),
        reach: v.optional(v.number()),
        likes: v.optional(v.number()),
        comments: v.optional(v.number()),
        saves: v.optional(v.number()),
        shares: v.optional(v.number()),
        clicks: v.number(),
        orders: v.number(),
        sales: v.number(),
      }),
    ),
    nextWindow: v.optional(v.union(v.literal("24h"), v.literal("72h"), v.literal("7d"))),
    nextWindowAt: v.optional(v.number()),
    pendingJobId: v.optional(v.id("agentJobs")),
    done: v.boolean(),
  })
    .index("by_job", ["jobId"])
    .index("by_user", ["userId", "postedAt"])
    .index("by_due", ["done", "nextWindowAt"]),

  experiments: defineTable({
    scope: v.union(v.literal("USER"), v.literal("GLOBAL")),
    userId: v.optional(v.id("users")),
    channel: v.string(),
    dimension: v.union(v.literal("HOOK"), v.literal("CTA"), v.literal("HOUR")),
    variant: v.string(),
    samples: v.number(),
    sumClicks: v.number(),
    sumOrders: v.number(),
    sumSales: v.number(),
    sumEngagement: v.number(),
    status: v.union(v.literal("RUNNING"), v.literal("PROMOTED"), v.literal("RETIRED")),
    lift: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_scope_user", ["scope", "userId", "channel"])
    .index("by_scope_channel", ["scope", "channel", "dimension"]),

  playbooks: defineTable({
    scope: v.union(v.literal("USER"), v.literal("GLOBAL")),
    userId: v.optional(v.id("users")),
    channel: v.string(),
    rules: v.array(v.object({ dimension: v.string(), variant: v.string(), lift: v.number(), samples: v.number(), promotedAt: v.number() })),
    updatedAt: v.number(),
  }).index("by_scope_user_channel", ["scope", "userId", "channel"]),
});
