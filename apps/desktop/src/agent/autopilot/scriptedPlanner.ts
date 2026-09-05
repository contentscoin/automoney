import type { Action } from "./actions";
import type { Planner, PlannerInput } from "./planner";

/** 테스트용: 스냅샷 요소 이름/역할로 다음 액션을 고르는 간단한 휴리스틱 플래너 (LLM 없이 픽스처 페이지 게시 가능) */
export const scriptedPlanner: Planner = {
  name: "scripted",
  async next(input: PlannerInput): Promise<Action> {
    const els = input.snapshot.elements;
    const typed = input.history.some((h) => h.action.type === "type");
    const uploaded = input.history.some((h) => h.action.type === "upload");
    const clickedCompose = input.history.some((h) => h.action.type === "click" && /compose|만들기|new/i.test(h.outcome + JSON.stringify(h.action)));
    const find = (pred: (e: (typeof els)[number]) => boolean) => els.find(pred);

    if (input.hasMedia && !uploaded) {
      const fi = find((e) => !!e.fileInput);
      if (fi) return { type: "upload", ref: fi.ref };
    }
    if (!typed) {
      const editor = find((e) => e.role === "textbox" && !e.fileInput && !(e.value ?? "").length);
      if (editor) return { type: "type", ref: editor.ref, text: input.text };
      const compose = find((e) => /compose|새|new|만들기|create/i.test(e.name) || e.href === "/compose");
      if (compose && !clickedCompose) return { type: "click", ref: compose.ref, reason: "open composer" };
      return { type: "fail", reason: "no editor found" };
    }
    const postLink = find((e) => /\/(status|post|p|video)\//.test(e.href ?? ""));
    if (postLink) return { type: "done", summary: "posted", postUrl: postLink.href ?? null };
    if (!input.publishAllowed) return { type: "done", summary: "ready", postUrl: null };
    const post = find((e) => e.role === "button" && /^(post|게시|공유|발행|share|publish|tweet)$/i.test(e.name.trim()) && !e.disabled);
    if (post && !input.history.some((h) => h.action.type === "click" && (h.action as { ref: string }).ref === post.ref)) return { type: "click", ref: post.ref, reason: "publish" };
    return { type: "wait", ms: 500 };
  },
};
