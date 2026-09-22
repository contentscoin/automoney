import { describe, expect, it } from "vitest";
import {
  REVIEW_CHECKLIST_ITEMS,
  checkedReviewCount,
  emptyReviewChecklist,
  isReviewChecklistComplete,
} from "../components/content-review";

describe("content human-review checklist", () => {
  it("matches the four server review evidence fields", () => {
    expect(REVIEW_CHECKLIST_ITEMS.map(({ key }) => key)).toEqual([
      "productFacts",
      "adDisclosure",
      "mediaRightsAndFit",
      "finalCopy",
    ]);
  });

  it("starts incomplete and returns a new state for every card", () => {
    const first = emptyReviewChecklist();
    const second = emptyReviewChecklist();

    expect(first).not.toBe(second);
    expect(checkedReviewCount(first)).toBe(0);
    expect(isReviewChecklistComplete(first)).toBe(false);
  });

  it("only completes when every review item is checked", () => {
    const checklist = emptyReviewChecklist();
    checklist.productFacts = true;
    checklist.adDisclosure = true;
    checklist.mediaRightsAndFit = true;

    expect(checkedReviewCount(checklist)).toBe(3);
    expect(isReviewChecklistComplete(checklist)).toBe(false);

    checklist.finalCopy = true;
    expect(checkedReviewCount(checklist)).toBe(4);
    expect(isReviewChecklistComplete(checklist)).toBe(true);
  });
});
