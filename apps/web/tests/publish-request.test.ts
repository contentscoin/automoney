import { describe, expect, it } from "vitest";
import { publishRequestAttempt } from "../components/publish-request";

const snapshot = {
  spaceId: "space-1",
  text: "게시 본문",
  mediaUrls: ["https://cdn.example.com/image.jpg"],
  linkId: "link-1",
  pieceId: "piece-1",
  contentChannel: "INSTAGRAM_FEED",
  requireApproval: true,
  dryRun: false,
};

describe("publishRequestAttempt", () => {
  it("reuses the request id for an unchanged retry", () => {
    let created = 0;
    const createRequestId = () => `request_${++created}`;
    const first = publishRequestAttempt(null, snapshot, createRequestId);
    const retry = publishRequestAttempt(first, { ...snapshot, mediaUrls: [...snapshot.mediaUrls] }, createRequestId);

    expect(retry).toBe(first);
    expect(retry.clientRequestId).toBe("request_1");
    expect(created).toBe(1);
  });

  it("creates a new request id after any publish input changes", () => {
    let created = 0;
    const createRequestId = () => `request_${++created}`;
    const first = publishRequestAttempt(null, snapshot, createRequestId);
    const changed = publishRequestAttempt(first, { ...snapshot, dryRun: true }, createRequestId);

    expect(changed.clientRequestId).toBe("request_2");
    expect(changed.fingerprint).not.toBe(first.fingerprint);
  });

  it("creates a new request id when the approved publish format changes", () => {
    let created = 0;
    const createRequestId = () => `request_${++created}`;
    const first = publishRequestAttempt(null, snapshot, createRequestId);
    const changed = publishRequestAttempt(first, { ...snapshot, contentChannel: "INSTAGRAM_REEL" }, createRequestId);

    expect(changed.clientRequestId).toBe("request_2");
  });
});
