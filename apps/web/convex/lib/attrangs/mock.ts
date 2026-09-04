import { sha256Hex } from "../crypto";
import { attrangsProductUrl, type AttrangsAdapter, type AttrangsProduct } from "./adapter";

const FIXTURE: AttrangsProduct[] = [
  { attrangsProductId: 100001, name: "플라워 셔링 롱 원피스", price: 49000, salePrice: 44100, category: "원피스" },
  { attrangsProductId: 100002, name: "베이직 브이넥 니트", price: 32000, salePrice: null, category: "니트" },
  { attrangsProductId: 100003, name: "하이웨스트 와이드 슬랙스", price: 38000, salePrice: 34200, category: "팬츠" },
  { attrangsProductId: 100004, name: "트위드 크롭 자켓", price: 69000, salePrice: null, category: "아우터" },
  { attrangsProductId: 100005, name: "새틴 플리츠 스커트", price: 35000, salePrice: 31500, category: "스커트" },
  { attrangsProductId: 100006, name: "린넨 오버핏 셔츠", price: 29000, salePrice: null, category: "블라우스" },
  { attrangsProductId: 100007, name: "하객룩 랩 원피스", price: 55000, salePrice: 49500, category: "원피스" },
  { attrangsProductId: 100008, name: "숏 트렌치 코트", price: 89000, salePrice: null, category: "아우터" },
].map((p) => ({
  ...p,
  imageUrls: [`https://picsum.photos/seed/attrangs-${p.attrangsProductId}/600/800`],
  detailUrl: attrangsProductUrl(p.attrangsProductId),
  status: "ACTIVE" as const,
}));

/** 결정론적 Mock: 같은 (partnerCode, product) 에는 항상 같은 tracking code. */
export const mockAttrangsAdapter: AttrangsAdapter = {
  async listProducts() {
    return FIXTURE;
  },
  async issueLink({ partnerUserCode, attrangsProductId, detailUrl }) {
    const digest = await sha256Hex(`${partnerUserCode}:${attrangsProductId}`);
    const trackingCode = `tc_${digest.slice(0, 20)}`;
    return { trackingCode, landingUrl: detailUrl };
  },
};

export function getAttrangsAdapter(): AttrangsAdapter {
  // 실제 API 어댑터는 ATTRANGS_API_BASE_URL 설정 시 여기서 분기한다 (M2 이후).
  return mockAttrangsAdapter;
}
