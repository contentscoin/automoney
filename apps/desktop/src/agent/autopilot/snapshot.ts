import type { Page } from "playwright";

/** 압축 시맨틱 스냅샷: 상호작용 요소에 ref 를 부여하고 모델이 읽기 쉬운 한 줄 요약으로 만든다 (ego lite 의 semantic snapshot 개념). */
export interface SnapshotElement {
  ref: string;
  tag: string;
  role: string;
  name: string;
  value?: string;
  placeholder?: string;
  href?: string;
  disabled?: boolean;
  editable?: boolean;
  fileInput?: boolean;
}

export interface Snapshot {
  url: string;
  title: string;
  elements: SnapshotElement[];
  text: string;
}

export const REF_ATTR = "data-am-ref";

export async function takeSnapshot(page: Page, opts: { maxElements?: number; maxTextChars?: number } = {}): Promise<Snapshot> {
  const maxElements = opts.maxElements ?? 80;
  const maxTextChars = opts.maxTextChars ?? 1500;
  const raw = await page.evaluate(
    ({ attr, maxElements, maxTextChars }) => {
      // 이전 스냅샷의 ref 제거 (숨겨진 요소에 남은 stale ref 가 다른 요소를 가리키는 것을 방지)
      document.querySelectorAll(`[${attr}]`).forEach((el) => el.removeAttribute(attr));
      const sel = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="menuitem"], [role="tab"], [role="checkbox"], [contenteditable="true"], [onclick]';
      const nodes = Array.from(document.querySelectorAll<HTMLElement>(sel));
      const visible = (el: HTMLElement) => {
        if (el instanceof HTMLInputElement && el.type === "file") return true;
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
      };
      const nameOf = (el: HTMLElement) => {
        const aria = el.getAttribute("aria-label");
        if (aria) return aria;
        const labelled = el.getAttribute("aria-labelledby");
        if (labelled) return Array.from(labelled.split(" ")).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
        if (el instanceof HTMLInputElement && el.labels?.[0]) return el.labels[0].textContent?.trim() ?? "";
        const t = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
        return t.slice(0, 80) || el.getAttribute("title") || el.getAttribute("name") || "";
      };
      const out: Record<string, unknown>[] = [];
      let i = 0;
      for (const el of nodes) {
        if (!visible(el)) continue;
        if (out.length >= maxElements) break;
        const ref = `e${++i}`;
        el.setAttribute(attr, ref);
        const tag = el.tagName.toLowerCase();
        const isInput = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
        out.push({
          ref,
          tag,
          role: el.getAttribute("role") ?? (tag === "a" ? "link" : tag === "button" ? "button" : isInput ? "textbox" : el.isContentEditable ? "textbox" : tag),
          name: nameOf(el),
          value: isInput ? (el as HTMLInputElement).value?.slice(0, 80) : el.isContentEditable ? (el.innerText || "").slice(0, 80) : undefined,
          placeholder: el.getAttribute("placeholder") ?? el.getAttribute("aria-placeholder") ?? undefined,
          href: tag === "a" ? (el as HTMLAnchorElement).getAttribute("href") ?? undefined : undefined,
          disabled: (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true" || undefined,
          editable: isInput || el.isContentEditable || undefined,
          fileInput: el instanceof HTMLInputElement && el.type === "file" ? true : undefined,
        });
      }
      const text = (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, maxTextChars);
      return { url: location.href, title: document.title, elements: out, text };
    },
    { attr: REF_ATTR, maxElements, maxTextChars },
  );
  return raw as unknown as Snapshot;
}

/** 모델 프롬프트용 텍스트 렌더링 */
export function renderSnapshot(s: Snapshot): string {
  const lines = s.elements.map((e) => {
    const bits = [`[${e.ref}]`, e.role];
    if (e.name) bits.push(JSON.stringify(e.name));
    if (e.placeholder) bits.push(`placeholder=${JSON.stringify(e.placeholder)}`);
    if (e.value) bits.push(`value=${JSON.stringify(e.value)}`);
    if (e.href) bits.push(`href=${e.href.slice(0, 60)}`);
    if (e.disabled) bits.push("disabled");
    if (e.fileInput) bits.push("file-input");
    if (e.editable && !e.fileInput) bits.push("editable");
    return bits.join(" ");
  });
  return `URL: ${s.url}\nTITLE: ${s.title}\nELEMENTS:\n${lines.join("\n")}\nTEXT: ${s.text}`;
}
