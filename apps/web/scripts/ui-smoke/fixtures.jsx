import { useSyncExternalStore } from "react";

// UI-only deterministic fixtures. No production endpoints, auth tokens or network calls.
const now = Date.UTC(2026, 9, 9, 9);
const product = { _id: "product-1", name: "가을 니트 스타일링 상품", price: 39000, salePrice: 35000, imageUrls: [], status: "ACTIVE" };
const material = (id, status, title) => ({ _id: id, kind: "TEXT", status, title, bodyText: "상품 카탈로그를 기준으로 정리한 운영용 텍스트 자료입니다.", rightsStatus: "OWNED", rightsNote: "운영사 작성 원문", productId: product._id, createdAt: now, updatedAt: now });
const ready = material("material-ready", "READY", "사용 준비된 상품 자료");
const draft = material("material-draft", "DRAFT", "검토 전 자료");
const piece = { _id: "piece-approved", channel: "THREADS", caption: "오늘의 가을 스타일링 자료입니다. 상품은 35,000원이며 자세한 정보는 링크에서 확인하세요.", hashtags: ["광고", "가을코디"], script: null, mediaUrls: [], qualityScore: 100, qualityReport: { violations: [], fixed: [] }, status: "APPROVED", visibility: "SHARED", generatedBy: "manual", usageCount: 0, mine: false, magazineTitle: null, productName: product.name, productId: product._id, collectionTitle: "가을 콘텐츠 묶음", collectionStatus: "PUBLISHED" };
const collection = { _id: "collection-draft", title: "가을 콘텐츠 묶음", summary: "상품 사실과 자료 사용권을 확인하는 테스트용 묶음", tags: ["가을코디", "니트"], status: "DRAFT", sourceMaterialIds: [ready._id], pieceIds: [], materialCount: 1, pieceCount: 0, approvedPieceCount: 0, revision: 1, createdAt: now, updatedAt: now, pieces: [], runs: [{ _id: "run-failed", status: "FAILED", channels: ["THREADS"], createdAt: now, errorMessage: "PC 연결이 끊겨 생성하지 못했습니다. 연결을 확인하세요." }] };
const space = { _id: "space-threads", name: "브랜드 Threads", platform: "THREADS", handle: "brand_demo", authMode: "BROWSER", sessionState: "HEALTHY", locked: false, dailyPostLimit: 3 };
const liveIssue = { code: "LIVE_PUBLISH_DISABLED", message: "현재 실제 게시는 준비 중입니다. 콘텐츠 제작과 테스트 실행은 사용할 수 있습니다.", href: "/dashboard/publish?dryRun=1", scope: "live" };
const state = {
  materials: [draft, ready], collections: [collection], products: [product], pieces: [piece], spaces: [space],
  links: [{ _id: "link-demo", product, origin: "MOCK", status: "ACTIVE", trackingCode: "mock-track", shortCode: "DEMO123", targetUrl: "https://example.invalid/product", issuedAt: now, clickCount: 12 }],
  schedules: [{ _id: "schedule-paused", spaceId: space._id, spaceName: space.name, platform: "THREADS", kind: "DAILY", timeOfDay: "10:00", daysOfWeek: [], jitterMinutes: 15, text: piece.caption, mediaUrls: [], autoApprove: false, enabled: false, nextRunAt: null, lastRunAt: null, lastSkipReason: "LIVE_PUBLISH_DISABLED", lastSkippedAt: now }],
  readiness: { checkedAt: now, livePublishEnabled: false, partnerMode: "pool", publicSiteConfigured: true, metaConfigured: false, minimumDesktopVersion: "0.1.16", device: { id: "device-1", name: "운영 PC", online: true, appVersion: "0.1.16", compatible: true, codexInstalled: true, codexLoggedIn: true }, aiReady: true, issues: [liveIssue], spaces: [{ id: space._id, name: space.name, platform: "THREADS", authMode: "BROWSER", readyForTest: true, readyForLive: false, issues: [liveIssue] }], links: { liveCount: 0, demoCount: 1 } },
};
let revision = 0;
const listeners = new Set();
const calls = [];
let nextFailure = null;
const refresh = () => { revision++; listeners.forEach((listener) => listener()); };
const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
const readRevision = () => revision;
export const api = new Proxy({}, { get: (_, module) => new Proxy({}, { get: (_, method) => `${String(module)}:${String(method)}` }) });

function query(name, args) {
  if (args === "skip") return undefined;
  switch (name) {
    case "adminContent:summary": return { materials: { ready: state.materials.filter((row) => row.status === "READY").length, draft: state.materials.filter((row) => row.status === "DRAFT").length }, collections: { inReview: 0, published: 0 }, truncated: false };
    case "adminContent:paginateMaterials": return state.materials;
    case "adminContent:paginateCollections": return state.collections;
    case "adminContent:getCollection": {
      const item = state.collections.find((row) => row._id === args.collectionId);
      return item ? { ...item, materials: state.materials.filter((row) => item.sourceMaterialIds.includes(row._id)) } : null;
    }
    case "products:search": return state.products.filter((row) => !args?.term || row.name.includes(args.term));
    case "content:listLibrary": return state.pieces;
    case "content:getPublishPiece": return state.pieces.find((row) => row._id === args.pieceId) ?? null;
    case "spaces:listMine": return state.spaces;
    case "links:listMine": return state.links;
    case "schedules:listMine": return state.schedules;
    case "jobs:listMine": return [];
    case "readiness:getMine": return state.readiness;
    default: throw new Error(`Unmocked query: ${name}`);
  }
}
export function useQuery(name, args) {
  useSyncExternalStore(subscribe, readRevision, readRevision);
  return query(name, args);
}
export function usePaginatedQuery(name, args) {
  return { results: useQuery(name, args), status: "Exhausted", isLoading: false, loadMore: () => {} };
}
async function mutate(name, args) {
  calls.push({ name, args });
  if (nextFailure === name) { nextFailure = null; throw new Error("테스트 오류: 연결을 확인한 뒤 다시 저장하세요."); }
  let result = { ok: true };
  if (name === "adminContent:createMaterial") {
    const row = { ...args, _id: `material-created-${revision}`, status: "DRAFT", createdAt: now + revision, updatedAt: now + revision };
    state.materials = [row, ...state.materials];
    result = { materialId: row._id, updatedAt: row.updatedAt };
  } else if (name === "adminContent:markMaterialReady") {
    const current = state.materials.find((row) => row._id === args.materialId);
    if (!current || current.updatedAt !== args.expectedUpdatedAt) throw new Error("자료가 변경되었습니다. 최신 자료를 확인하세요.");
    state.materials = state.materials.map((row) => row._id === args.materialId ? { ...row, status: "READY", updatedAt: row.updatedAt + 1 } : row);
  } else if (name === "adminContent:updateMaterial") {
    const current = state.materials.find((row) => row._id === args.materialId);
    if (!current || current.updatedAt !== args.expectedUpdatedAt) throw new Error("자료가 변경되었습니다. 최신 자료를 확인하세요.");
    state.materials = state.materials.map((row) => row._id === args.materialId ? { ...row, ...args, updatedAt: row.updatedAt + 1 } : row);
  } else if (name === "adminContent:createCollection") {
    const row = { ...collection, ...args, _id: `collection-created-${revision}`, materials: undefined, pieces: [], runs: [], revision: 1, materialCount: args.sourceMaterialIds.length, createdAt: now + revision, updatedAt: now + revision };
    state.collections = [row, ...state.collections];
    result = { collectionId: row._id };
  } else if (name === "adminContent:updateCollection") {
    const current = state.collections.find((row) => row._id === args.collectionId);
    if (!current || current.revision !== args.expectedRevision) throw new Error("묶음이 변경되었습니다. 최신 묶음을 확인하세요.");
    state.collections = state.collections.map((row) => row._id === args.collectionId ? { ...row, ...args, revision: row.revision + 1, updatedAt: row.updatedAt + 1 } : row);
  } else if (name === "links:issue") {
    state.links = state.links.map((row) => ({ ...row, status: "DISABLED" }));
    const real = { ...state.links[0], _id: "link-real", origin: "POOL", status: "ACTIVE", shortCode: "REAL123", issuedAt: now + 1, clickCount: 0 };
    state.links.unshift(real);
    result = { linkId: real._id, shortCode: real.shortCode, existed: false };
  } else if (name === "jobs:enqueuePublish") {
    result = "mock-publish-job";
  } else {
    throw new Error(`Unmocked mutation: ${name}`);
  }
  refresh();
  return result;
}
export function useMutation(name) { return (args) => mutate(name, args); }
export const useAction = useMutation;
window.__uiSmoke = { calls, failNext: (name) => { nextFailure = name; }, state: () => state, mocked: true };
