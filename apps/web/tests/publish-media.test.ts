import { describe, expect, it } from "vitest";
import { inspectPublishMedia, validatePieceMediaEdit } from "../components/publish-media";

describe("publish media readiness", () => {
  it("does not treat product still images as prepared Reels media", () => {
    const result = inspectPublishMedia({
      mediaUrls: ["https://cdn.example.com/product.jpg"],
      pieceChannel: "INSTAGRAM_REEL",
      platform: "INSTAGRAM",
    });

    expect(result).toMatchObject({ requiresVideo: true, hasVerifiedVideo: false, mediaInputInvalid: true });
  });

  it("requires a video for a direct TikTok publish", () => {
    const result = inspectPublishMedia({
      mediaUrls: ["https://cdn.example.com/product.webp"],
      platform: "TIKTOK",
    });

    expect(result).toMatchObject({ requiresVideo: true, hasVerifiedVideo: false, mediaInputInvalid: true });
  });

  it.each(["mp4", "mov", "m4v", "webm"])("accepts an HTTPS .%s video URL", (extension) => {
    const result = inspectPublishMedia({
      mediaUrls: [`https://cdn.example.com/shortform.${extension}?signed=1`],
      pieceChannel: "INSTAGRAM_REEL",
      platform: "INSTAGRAM",
    });

    expect(result).toMatchObject({ hasVerifiedVideo: true, mediaInputInvalid: false });
  });

  it("does not count an insecure video URL as ready", () => {
    const result = inspectPublishMedia({
      mediaUrls: ["http://cdn.example.com/shortform.mp4"],
      pieceChannel: "TIKTOK",
      platform: "TIKTOK",
    });

    expect(result.invalidMediaUrls).toHaveLength(1);
    expect(result).toMatchObject({ hasVerifiedVideo: false, mediaInputInvalid: true });
  });

  it("does not accept multiple assets for a short-form post", () => {
    const result = inspectPublishMedia({
      mediaUrls: ["https://cdn.example.com/a.mp4", "https://cdn.example.com/b.mp4"],
      pieceChannel: "INSTAGRAM_REEL",
      platform: "INSTAGRAM",
    });

    expect(result).toMatchObject({ hasVerifiedVideo: false, mediaInputInvalid: true });
  });

  it("allows an HTTPS still image for an Instagram feed", () => {
    const result = inspectPublishMedia({
      mediaUrls: ["https://cdn.example.com/feed.jpg"],
      pieceChannel: "INSTAGRAM_FEED",
      platform: "INSTAGRAM",
    });

    expect(result).toMatchObject({ requiresVideo: false, mediaInputInvalid: false });
  });

  it("rejects video or ambiguous media for an Instagram feed", () => {
    for (const url of ["https://cdn.example.com/feed.mp4", "https://cdn.example.com/media?id=1"]) {
      expect(inspectPublishMedia({ mediaUrls: [url], pieceChannel: "INSTAGRAM_FEED", platform: "INSTAGRAM" }))
        .toMatchObject({ requiresVideo: false, mediaInputInvalid: true });
    }
  });
});

describe("piece media editing", () => {
  it.each(["INSTAGRAM_REEL", "TIKTOK"])("requires exactly one HTTPS video for %s", (channel) => {
    expect(validatePieceMediaEdit(["https://cdn.example.com/product.jpg"], channel)).toMatch(/HTTPS 영상 URL 1개/);
    expect(validatePieceMediaEdit([
      "https://cdn.example.com/product.jpg",
      "https://cdn.example.com/clip.mp4",
    ], channel)).toMatch(/HTTPS 영상 URL 1개/);
    expect(validatePieceMediaEdit(["http://cdn.example.com/clip.mp4"], channel)).toMatch(/HTTPS 영상 URL 1개/);
    expect(validatePieceMediaEdit(["https://cdn.example.com/clip.mp4"], channel)).toBeNull();
  });

  it("allows multiple HTTPS assets for non-short-form channels", () => {
    expect(validatePieceMediaEdit([
      "https://cdn.example.com/one.jpg",
      "https://cdn.example.com/two.webm",
    ], "THREADS")).toBeNull();
  });
});
