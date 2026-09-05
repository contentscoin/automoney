import { afterEach, describe, expect, it } from "vitest";
import type { ContentGeneratePayload } from "@automoney/shared";
import { handleContentGenerate } from "../src/agent/jobs/handlers";
import type { JobContext } from "../src/agent/jobs/context";

const payload: ContentGeneratePayload = {
  channels: ["THREADS", "INSTAGRAM_REEL"],
  atoms: [
    { atomType: "HOOK", text: "올가을 니트는 루즈핏이 대세입니다.", productId: null, rank: 1 },
    { atomType: "STYLE_TIP", text: "와이드 슬랙스와 매치하면 편안하면서도 단정해 보여요.", productId: null, rank: 2 },
  ],
  products: [{ attrangsProductId: 100001, name: "루즈핏 니트", price: 39000, salePrice: 35000, detailUrl: "https://attrangs.co.kr/shop/view.php?index_no=100001", category: "니트" }],
  magazineTitle: "가을 니트 스타일링",
};

function ctx(): JobContext & { stages: string[] } {
  const stages: string[] = [];
  return {
    stages,
    cfg: {} as JobContext["cfg"],
    api: {} as JobContext["api"],
    job: { id: "j1", jobType: "content.generate", payload: payload as unknown as Record<string, unknown>, spaceId: null, space: null, leaseMs: 1000 } as unknown as JobContext["job"],
    async checkpoint(stage) {
      stages.push(stage);
    },
  };
}

afterEach(() => {
  delete process.env.AUTOMONEY_CONTENT_PROVIDER;
});

describe("content.generate handler", () => {
  it("uses codex output when parseable and reports generatedBy=codex", async () => {
    const c = ctx();
    let prompt = "";
    const out = await handleContentGenerate(c, {
      generate: async (p) => {
        prompt = p;
        return { ok: true, text: 'here you go:\n[{"channel":"THREADS","caption":"니트 추천","hashtags":["광고","니트"],"mediaUrls":[]},{"channel":"X","caption":"허용 안 된 채널","hashtags":[]}]' };
      },
    });
    expect(prompt).toContain("THREADS");
    expect(prompt).toContain("루즈핏 니트");
    expect(out.result.kind).toBe("ok");
    const data = out.result.data as { pieces: { channel: string }[]; generatedBy: string; fallbackReason: string | null };
    expect(data.generatedBy).toBe("codex");
    expect(data.pieces.map((p) => p.channel)).toEqual(["THREADS"]);
    expect(data.fallbackReason).toBeNull();
    expect(c.stages).toContain("codex_generating");
  });

  it("falls back to the template generator when codex is unavailable or unparseable", async () => {
    const c = ctx();
    const out = await handleContentGenerate(c, { generate: async () => ({ ok: false, reason: "codex not logged in" }) });
    const data = out.result.data as { pieces: { channel: string; script?: string }[]; generatedBy: string; fallbackReason: string };
    expect(data.generatedBy).toBe("template");
    expect(data.fallbackReason).toMatch(/not logged in/);
    expect(data.pieces.map((p) => p.channel).sort()).toEqual(["INSTAGRAM_REEL", "THREADS"]);
    expect(data.pieces.find((p) => p.channel === "INSTAGRAM_REEL")?.script).toBeTruthy();

    const c2 = ctx();
    const out2 = await handleContentGenerate(c2, { generate: async () => ({ ok: true, text: "no json here" }) });
    expect((out2.result.data as { generatedBy: string }).generatedBy).toBe("template");
  });

  it("skips codex entirely when AUTOMONEY_CONTENT_PROVIDER=template", async () => {
    process.env.AUTOMONEY_CONTENT_PROVIDER = "template";
    const c = ctx();
    let called = false;
    const out = await handleContentGenerate(c, {
      generate: async () => {
        called = true;
        return { ok: true, text: "[]" };
      },
    });
    expect(called).toBe(false);
    expect((out.result.data as { generatedBy: string }).generatedBy).toBe("template");
    expect(c.stages).not.toContain("codex_generating");
  });
});
