import fs from "node:fs";
import { describe, expect, it, vi, afterEach } from "vitest";
import { detectBrowsers } from "../src/agent/spaces/manager";

afterEach(() => vi.restoreAllMocks());

describe("detectBrowsers", () => {
  it("reports the first existing path per browser on windows", () => {
    vi.spyOn(fs, "existsSync").mockImplementation((p) => String(p).includes("Program Files (x86)\\Microsoft\\Edge"));
    expect(detectBrowsers("win32").filter((b) => b.label !== "번들 Chromium")).toEqual([{ label: "Edge", path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" }]);
  });

  it("returns no system browsers when none are installed", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    expect(detectBrowsers("win32")).toEqual([]);
    expect(detectBrowsers("darwin")).toEqual([]);
  });

  it("finds chrome on macOS and ignores unknown platforms", () => {
    vi.spyOn(fs, "existsSync").mockImplementation((p) => String(p).startsWith("/Applications/Google Chrome.app"));
    expect(detectBrowsers("darwin")).toEqual([{ label: "Chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }]);
    expect(detectBrowsers("aix")).toEqual([]);
  });
});
