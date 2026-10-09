import { describe, expect, it } from "vitest";
import { validateMediaIntegrity, validatePublishPayload, type MediaIntegrity, type PublishPayload } from "./index";

const url = "https://media.example.test/reviewed.jpg";
const manifest: MediaIntegrity = { url, sha256: "a".repeat(64), sizeBytes: 3, mimeType: "image/jpeg" };
const payload: PublishPayload = { spaceId: "s", platform: "THREADS", text: "reviewed", mediaUrls: [url], dryRun: true };

describe("publish media integrity contract", () => {
  it("keeps legacy payloads valid and accepts an exact ordered manifest", () => {
    expect(validatePublishPayload(payload)).toBeNull();
    expect(validatePublishPayload({ ...payload, mediaIntegrity: [manifest] })).toBeNull();
    expect(validateMediaIntegrity([], [])).toBeNull();
    expect(validateMediaIntegrity([url], [{ ...manifest, sha256: manifest.sha256.toUpperCase() }])).toBeNull();
  });

  it("rejects missing, extra, reordered and malformed manifest entries even in dry-run", () => {
    const invalid = [
      null, {}, [], [null], [manifest, manifest],
      [{ ...manifest, url: `${url}?changed=1` }],
      [{ ...manifest, sha256: "not-a-hash" }],
      [{ ...manifest, sha256: "g".repeat(64) }],
      ...[0, -1, 1.5, Infinity, NaN, "3", 20 * 1024 * 1024 + 1].map(sizeBytes => [{ ...manifest, sizeBytes }]),
      ...["text/html", "image/avif", "image/jpeg; charset=utf-8", "IMAGE/JPEG", null].map(mimeType => [{ ...manifest, mimeType }]),
      [{ ...manifest, mimeType: "video/mp4" }],
    ];
    for (const mediaIntegrity of invalid) {
      expect(validatePublishPayload({ ...payload, mediaIntegrity } as PublishPayload)).toMatch(/media integrity/);
    }
    const second = { ...manifest, url: "https://media.example.test/second.jpg" };
    expect(validateMediaIntegrity([url, second.url], [second, manifest])).toMatch(/order/);
  });
});
