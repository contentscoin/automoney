import { describe, expect, it } from "vitest";
import { GITHUB_RELEASES, resolveFeed } from "../src/updater";

describe("updater feed resolution", () => {
  it("defaults to GitHub Releases when no feed url is configured", () => {
    expect(resolveFeed(undefined)).toEqual({ provider: "github", ...GITHUB_RELEASES });
    expect(resolveFeed("   ")).toEqual({ provider: "github", ...GITHUB_RELEASES });
  });
  it("uses a generic https feed when configured and rejects http unless allowed", () => {
    expect(resolveFeed("https://updates.example.com/desktop")).toEqual({ provider: "generic", url: "https://updates.example.com/desktop" });
    expect(resolveFeed("http://127.0.0.1:8080/feed", false)).toBeNull();
    expect(resolveFeed("http://127.0.0.1:8080/feed", true)).toEqual({ provider: "generic", url: "http://127.0.0.1:8080/feed" });
  });
  it("disables on 'off' or an invalid url", () => {
    expect(resolveFeed("off")).toBeNull();
    expect(resolveFeed("OFF")).toBeNull();
    expect(resolveFeed("not a url")).toBeNull();
  });
});
