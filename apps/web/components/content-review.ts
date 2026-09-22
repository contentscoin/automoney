export const REVIEW_CHECKLIST_ITEMS = [
  {
    key: "productFacts",
    label: "상품 사실·가격 확인",
    description: "상품명·가격·혜택이 고정된 상품 근거와 일치합니다.",
  },
  {
    key: "adDisclosure",
    label: "광고 표기 확인",
    description: "채널과 콘텐츠에 필요한 광고 표기가 포함됐습니다.",
  },
  {
    key: "mediaRightsAndFit",
    label: "미디어 사용권·채널 적합성 확인",
    description: "미디어 사용 권한과 선택 채널의 형식·규격을 확인했습니다.",
  },
  {
    key: "finalCopy",
    label: "최종 문구 확인",
    description: "오탈자, 표현, CTA와 게시될 최종 문구를 직접 확인했습니다.",
  },
] as const;

export type ReviewChecklistKey = (typeof REVIEW_CHECKLIST_ITEMS)[number]["key"];
export type ReviewChecklist = Record<ReviewChecklistKey, boolean>;

export function emptyReviewChecklist(): ReviewChecklist {
  return {
    productFacts: false,
    adDisclosure: false,
    mediaRightsAndFit: false,
    finalCopy: false,
  };
}

export function checkedReviewCount(checklist: ReviewChecklist): number {
  return REVIEW_CHECKLIST_ITEMS.filter(({ key }) => checklist[key]).length;
}

export function isReviewChecklistComplete(checklist: ReviewChecklist): boolean {
  return checkedReviewCount(checklist) === REVIEW_CHECKLIST_ITEMS.length;
}
