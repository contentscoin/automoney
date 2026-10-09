import type { Doc } from "../_generated/dataModel";

/** Imported/API links retain their identity when demo links are superseded. */
export function isDemoMarketingLink(link: Pick<Doc<"marketingLinks">, "origin">): boolean {
  return link.origin === "MOCK" || link.origin === "DEMO";
}

export function partnerLinkMode(): "mock" | "pool" {
  return (process.env.ATTRANGS_MODE ?? "mock").trim().toLowerCase() === "mock" ? "mock" : "pool";
}

export const DEMO_LINK_PUBLISH_MESSAGE = "데모 마케팅 링크는 실제 수익을 추적하지 않아 실게시에 사용할 수 없습니다. 내 링크에서 실제 파트너 링크를 발급하거나 테스트 실행을 선택하세요.";
