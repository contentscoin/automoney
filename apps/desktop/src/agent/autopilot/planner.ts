import type { Action } from "./actions";
import type { Snapshot } from "./snapshot";

export interface PlannerInput {
  goal: string;
  platform: string;
  text: string;
  hasMedia: boolean;
  snapshot: Snapshot;
  history: { step: number; action: Action; outcome: string }[];
  publishAllowed: boolean;
}

export interface Planner {
  name: string;
  next(input: PlannerInput): Promise<Action>;
}

export const SYSTEM_RULES = `You are a browser automation planner for posting to a social network.
Return exactly one JSON object and nothing else. Allowed actions:
{"type":"click","ref":"e3","reason":"..."}
{"type":"type","ref":"e5","text":"...","clear":false}
{"type":"upload","ref":"e7"}            // only for file-input refs
{"type":"press","key":"Escape"}             // only Escape/Tab/arrows/PageUp/PageDown/Home/End
{"type":"navigate","url":"https://..."}
{"type":"scroll","direction":"down"}
{"type":"wait","ms":1000}
{"type":"done","summary":"...","postUrl":"https://... or null"}
{"type":"fail","reason":"..."}
Rules: never click account/security/billing/delete/logout controls. Never use Enter, Space, Control, Meta, Alt, or keyboard shortcuts to submit. Do not click publish/share/post/submit controls unless publishAllowed is true; if publishAllowed is false and the draft is ready, return done with summary "ready". Navigate only within the current social platform. Return done with summary "posted" only after a new canonical post URL is visible in the page. Prefer refs from the snapshot; do not invent refs. Type the exact post text once.`;
