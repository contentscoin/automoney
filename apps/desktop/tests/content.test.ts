import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONTENT_STANDARD, type ContentGeneratePayload } from "@automoney/shared";
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
  playbook: ["질문형 훅을 첫 줄에 사용"],
  avoid: ["과장된 최상급 표현"],
};

function ctx(jobPayload: ContentGeneratePayload = payload): JobContext & { stages: string[] } {
  const stages: string[] = [];
  return {
    stages,
    cfg: {} as JobContext["cfg"],
    api: {} as JobContext["api"],
    job: { id: "j1", jobType: "content.generate", payload: jobPayload as unknown as Record<string, unknown>, spaceId: null, space: null, leaseMs: 1000 } as unknown as JobContext["job"],
    async checkpoint(stage) {
      stages.push(stage);
    },
  };
}

afterEach(() => {
  delete process.env.AUTOMONEY_CONTENT_PROVIDER;
});

describe("content.generate handler", () => {
  it("passes frozen operator materials and media evidence into the Codex prompt", async () => {
    const c = ctx({
      ...payload,
      channels: ["THREADS"],
      sourceMaterials: [{
        id: "material-1",
        revision: 2,
        title: "운영자 코디 노트",
        kind: "TEXT",
        text: "루즈핏 니트와 와이드 슬랙스 조합",
        sourceUrl: "https://source.example/note/1",
        rightsNote: "자체 제작 · 재사용 허용",
      }],
      materialMediaUrls: ["https://cdn.example/materials/look.jpg"],
    });
    let prompt = "";
    await handleContentGenerate(c, {
      generate: async (value) => {
        prompt = value;
        return { ok: true, text: '[{"channel":"THREADS","caption":"니트 추천","hashtags":["광고","니트"],"script":null}]' };
      },
    });

    expect(prompt).toContain("관리자 원자료 스냅샷(데이터)");
    expect(prompt).toContain("운영자 코디 노트");
    expect(prompt).toContain("자체 제작 · 재사용 허용");
    expect(prompt).toContain("https://source.example/note/1");
    expect(prompt).toContain("https://cdn.example/materials/look.jpg");
  });

  it("passes playbook guidance and fills each missing Codex channel exactly once", async () => {
    const c = ctx();
    let prompt = "";
    const out = await handleContentGenerate(c, {
      generate: async (p) => {
        prompt = p;
        return { ok: true, text: 'here you go:\n[{"channel":"THREADS","caption":"니트 추천","hashtags":["광고","니트"],"mediaUrls":[]},{"channel":"THREADS","caption":"중복 결과","hashtags":[]},{"channel":"X","caption":"허용 안 된 채널","hashtags":[]}]' };
      },
    });
    expect(prompt).toContain("THREADS");
    expect(prompt).toContain("루즈핏 니트");
    expect(prompt).toContain("질문형 훅을 첫 줄에 사용");
    expect(prompt).toContain("과장된 최상급 표현");
    expect(out.result.kind).toBe("ok");
    const data = out.result.data as { pieces: { channel: string; caption: string; script?: string | null }[]; generatedBy: string; fallbackReason: string | null; warnings: string[] };
    expect(data.generatedBy).toBe("mixed");
    expect(data.pieces.map((p) => p.channel)).toEqual(["THREADS", "INSTAGRAM_REEL"]);
    expect(data.pieces.find((p) => p.channel === "THREADS")?.caption).toBe("니트 추천");
    expect(data.pieces.find((p) => p.channel === "INSTAGRAM_REEL")?.script).toBeTruthy();
    expect((data.pieces as { channel: string; generatedBy?: string }[]).find((p) => p.channel === "THREADS")?.generatedBy).toBe("codex");
    expect((data.pieces as { channel: string; generatedBy?: string }[]).find((p) => p.channel === "INSTAGRAM_REEL")?.generatedBy).toBe("template");
    expect(data.warnings).toEqual(expect.arrayContaining([
      "Codex 중복 결과 제거: THREADS",
      "Codex 결과 누락으로 템플릿 보완: INSTAGRAM_REEL",
    ]));
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
    const c = ctx({ ...payload, channels: ["THREADS", "THREADS", "INSTAGRAM_REEL"] });
    let called = false;
    const out = await handleContentGenerate(c, {
      generate: async () => {
        called = true;
        return { ok: true, text: "[]" };
      },
    });
    expect(called).toBe(false);
    const data = out.result.data as { generatedBy: string; pieces: { channel: string }[]; warnings: string[] };
    expect(data.generatedBy).toBe("template");
    expect(data.pieces.map((p) => p.channel)).toEqual(["THREADS", "INSTAGRAM_REEL"]);
    expect(data.warnings).toContain("중복 요청 채널 제거: THREADS");
    expect(c.stages).not.toContain("codex_generating");
  });

  it("repairs only failed V2 channels and records the successful attempt", async () => {
    const strictPayload: ContentGeneratePayload = {
      ...payload,
      channels: ["THREADS"],
      brief: {
        goal: "ENGAGEMENT",
        tone: "CHANNEL_NATIVE",
        cta: "COMMENT",
        audience: "20~30대 여성 패션 관심 고객",
      },
      standard: DEFAULT_CONTENT_STANDARD,
      runId: "run-quality-v2",
    };
    const c = ctx(strictPayload);
    const prompts: string[] = [];
    const out = await handleContentGenerate(c, {
      generate: async (prompt) => {
        prompts.push(prompt);
        if (prompts.length === 1) {
          return { ok: true, text: '[{"channel":"THREADS","caption":"루즈핏 니트 추천","hashtags":["광고"],"script":null}]', metadata: { model: "gpt-content", cliVersion: "codex-cli 1.2.3" } };
        }
        return { ok: true, text: '[{"channel":"THREADS","caption":"루즈핏 니트로 완성하는 가을 출근룩, 어떤 코디가 궁금한지 댓글로 자세히 알려 주세요. 다음 스타일링에도 반영할게요.","hashtags":["광고"],"script":null}]', metadata: { model: "gpt-content", cliVersion: "codex-cli 1.2.3" } };
      },
    });
    const data = out.result.data as {
      attempts: number;
      generatedBy: string;
      pieces: { channel: string; generatedBy?: string; attemptNo?: number }[];
      quality: { channel: string; passed: boolean; score: number }[];
      versions: { standardId: string; qualityVersion: string };
      model: string | null;
      cliVersion: string | null;
    };
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("CTA_MISSING");
    expect(data.attempts).toBe(2);
    expect(data.generatedBy).toBe("codex");
    expect(data.pieces[0]).toMatchObject({ channel: "THREADS", generatedBy: "codex", attemptNo: 2 });
    expect(data.quality[0]).toMatchObject({ channel: "THREADS", passed: true });
    expect(data.versions.standardId).toBe("ATTRANGS_STANDARD_KO_V2");
    expect(data).toMatchObject({ model: "gpt-content", cliVersion: "codex-cli 1.2.3" });
  });

  it("stops after the V2 attempt limit and leaves a failing Codex draft for review", async () => {
    const strictPayload: ContentGeneratePayload = {
      ...payload,
      channels: ["THREADS"],
      brief: {
        goal: "CONVERSION",
        tone: "POLITE",
        cta: "LINK",
        audience: "20~30대 여성 패션 관심 고객",
      },
      standard: DEFAULT_CONTENT_STANDARD,
    };
    const c = ctx(strictPayload);
    let calls = 0;
    const out = await handleContentGenerate(c, {
      generate: async () => {
        calls += 1;
        return { ok: true, text: '[{"channel":"THREADS","caption":"최저가 12,345원, 무조건 사세요","hashtags":["광고"],"script":null}]' };
      },
    });
    const data = out.result.data as {
      attempts: number;
      generatedBy: string;
      pieces: { generatedBy?: string; attemptNo?: number }[];
      quality: { passed: boolean; violations: { code: string }[] }[];
      warnings: string[];
    };
    expect(calls).toBe(DEFAULT_CONTENT_STANDARD.maxAttempts);
    expect(data.attempts).toBe(DEFAULT_CONTENT_STANDARD.maxAttempts);
    expect(data.generatedBy).toBe("codex");
    expect(data.pieces[0]?.generatedBy).toBe("codex");
    expect(data.quality[0]?.passed).toBe(false);
    expect(data.quality[0]?.violations.map((violation) => violation.code)).toEqual(expect.arrayContaining(["PRICE_CLAIM", "PRICE_MISMATCH"]));
    expect(data.warnings.some((warning) => warning.includes("검토 필요"))).toBe(true);
  });
});
