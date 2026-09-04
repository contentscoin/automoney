/**
 * 아뜨랑스 파트너 API 어댑터 인터페이스 (docs/04-integrations.md §1).
 * 실제 API 규격 합의 전까지는 Mock 구현을 사용한다.
 */
export interface AttrangsProduct {
  attrangsProductId: number;
  name: string;
  price: number;
  salePrice: number | null;
  category: string | null;
  imageUrls: string[];
  detailUrl: string;
  status: "ACTIVE" | "INACTIVE";
}

export interface IssuedLink {
  trackingCode: string;
  landingUrl: string;
}

export interface AttrangsAdapter {
  listProducts(input: { updatedSince?: number }): Promise<AttrangsProduct[]>;
  issueLink(input: { partnerUserCode: string; attrangsProductId: number; detailUrl: string }): Promise<IssuedLink>;
}

export function attrangsProductUrl(productId: number): string {
  return `https://attrangs.co.kr/shop/view.php?index_no=${productId}`;
}
