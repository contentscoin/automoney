import { describe, expect, it } from "vitest";
import { MCP_OAUTH, isAllowedRedirectUri } from "./mcpTools";
import { MCP_TOOLS, MCP_TOOL_MAP, allowedScopesForRole, validateToolArgs, visibleTools } from "./mcpTools";
import { classifyCta, classifyHook, evaluateLift, hourBucket, kstHour, playbookHint } from "./analytics";
import { buildGenerationPrompt } from "./content";

describe("mcp tool catalog", () => {
  it("has unique names, scopes and object schemas for every tool", () => {
    const names = MCP_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(18);
    for (const t of MCP_TOOLS) {
      expect(["mcp:read", "mcp:write", "admin:read", "super:read"]).toContain(t.scope);
      expect(t.inputSchema.type).toBe("object");
      for (const r of t.inputSchema.required ?? []) expect(t.inputSchema.properties[r]).toBeDefined();
    }
    expect(MCP_TOOL_MAP.post_publish!.dangerous).toBe(true);
    expect(MCP_TOOL_MAP.space_create!.dangerous).toBe(true);
  });

  it("filters tools by scope and role", () => {
    expect(visibleTools(["mcp:read"]).every((t) => t.scope === "mcp:read")).toBe(true);
    expect(visibleTools(["mcp:read", "mcp:write"]).some((t) => t.name === "post_publish")).toBe(true);
    expect(visibleTools(["mcp:read"]).some((t) => t.name === "super_stats")).toBe(false);
    expect(allowedScopesForRole("USER")).toEqual(["mcp:read", "mcp:write"]);
    expect(allowedScopesForRole("ADMIN")).toContain("admin:read");
    expect(allowedScopesForRole("SUPER_ADMIN")).toContain("super:read");
  });

  it("validates arguments: required, types, enums, ranges, unknown keys", () => {
    const t = MCP_TOOL_MAP.post_schedule!;
    expect(validateToolArgs(t, {})).toMatch(/missing required/);
    expect(validateToolArgs(t, { spaceId: "s", kind: "HOURLY", timeOfDay: "10:00" })).toMatch(/kind must be one of/);
    expect(validateToolArgs(t, { spaceId: "s", kind: "DAILY", timeOfDay: "10:00", jitterMinutes: 500 })).toMatch(/<= 120/);
    expect(validateToolArgs(t, { spaceId: "s", kind: "DAILY", timeOfDay: "10:00", bogus: 1 })).toMatch(/unknown argument/);
    expect(validateToolArgs(t, { spaceId: "s", kind: "DAILY", timeOfDay: "10:00", daysOfWeek: [1, 3] })).toBeNull();
    expect(validateToolArgs(MCP_TOOL_MAP.content_generate!, { channels: ["NOPE"] })).toMatch(/invalid value/);
    expect(validateToolArgs(MCP_TOOL_MAP.product_search!, "x")).toMatch(/must be an object/);
  });
});

describe("analytics helpers", () => {
  it("classifies hooks and CTAs from caption text", () => {
    expect(classifyHook("올가을 니트, 뭐 입을까요?\n본문")).toBe("QUESTION");
    expect(classifyHook("3가지 코디 공식")).toBe("NUMBER");
    expect(classifyHook("요즘 대세 루즈핏")).toBe("TREND");
    expect(classifyHook("검정 말고 아이보리")).toBe("CONTRAST");
    expect(classifyHook("39,000원 특가")).toBe("PRICE");
    expect(classifyHook("포근한 니트 셀렉션")).toBe("STATEMENT");
    expect(classifyCta("본문\n\n프로필 링크에서 확인 👀")).toBe("LINK");
    expect(classifyCta("본문\n저장해두고 보세요")).toBe("SAVE");
    expect(classifyCta("본문\n댓글로 알려주세요")).toBe("COMMENT");
    expect(classifyCta("본문")).toBe("NONE");
    expect(hourBucket(kstHour(Date.UTC(2026, 8, 5, 1, 0)))).toBe("MORNING"); // 10:00 KST
    expect(hourBucket(21)).toBe("EVENING");
  });

  it("promotes only with enough samples, 15% lift and significance", () => {
    expect(evaluateLift({ samples: 5, sum: 50 }, { samples: 40, sum: 100 }).reason).toBe("MIN_SAMPLES");
    expect(evaluateLift({ samples: 30, sum: 66 }, { samples: 60, sum: 120 }).reason).toBe("MIN_LIFT"); // 2.2 vs 2.0 = +10%
    expect(evaluateLift({ samples: 20, sum: 26 }, { samples: 20, sum: 20 }).reason).toBe("NOT_SIGNIFICANT"); // +30% but noisy
    const ok = evaluateLift({ samples: 60, sum: 300 }, { samples: 120, sum: 360 });
    expect(ok.promote).toBe(true);
    expect(ok.lift).toBeCloseTo(0.6667, 3);
    expect(evaluateLift({ samples: 2, sum: 9 }, { samples: 2, sum: 0 }, { minSamples: 2 }).reason).toBe("NO_CONTROL");
    expect(playbookHint({ dimension: "HOOK", variant: "QUESTION", lift: 0.23, samples: 24 })).toContain("질문형");
  });

  it("injects playbook hints and avoid list into the generation prompt", () => {
    const prompt = buildGenerationPrompt({ channels: ["THREADS"], atoms: [], products: [], playbook: ["[THREADS] 훅 유형 질문형 +23%"], avoid: ["톤이 안 맞음 (3회 거절)"] });
    expect(prompt).toContain("검증된 패턴");
    expect(prompt).toContain("질문형");
    expect(prompt).toContain("피해야 할 것");
    expect(buildGenerationPrompt({ channels: ["X"], atoms: [], products: [] })).not.toContain("검증된 패턴");
  });
});

describe("MCP OAuth redirect URI policy", () => {
  it("allows https, loopback http and custom schemes; rejects plain http, fragments, javascript:", () => {
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:6274/oauth/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:33418/cb")).toBe(true);
    expect(isAllowedRedirectUri("cursor://anysphere.cursor-mcp/oauth/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://evil.example.com/cb")).toBe(false);
    expect(isAllowedRedirectUri("https://a.example/cb#frag")).toBe(false);
    expect(isAllowedRedirectUri("javascript:alert(1)")).toBe(false);
    expect(isAllowedRedirectUri("not a url")).toBe(false);
    expect(MCP_OAUTH.accessTtlMs).toBeLessThan(MCP_OAUTH.refreshTtlMs);
  });
});

