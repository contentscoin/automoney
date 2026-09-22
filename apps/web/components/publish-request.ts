export interface PublishRequestSnapshot {
  spaceId: string;
  text: string;
  mediaUrls: readonly string[];
  contentChannel?: string;
  linkId?: string;
  pieceId?: string;
  requireApproval: boolean;
  dryRun: boolean;
}

export interface PublishRequestAttempt {
  fingerprint: string;
  clientRequestId: string;
}

/** Keep one request id while the exact publish input is retried; changed input starts a new attempt. */
export function publishRequestAttempt(
  previous: PublishRequestAttempt | null,
  snapshot: PublishRequestSnapshot,
  createRequestId: () => string,
): PublishRequestAttempt {
  const fingerprint = JSON.stringify([
    snapshot.spaceId,
    snapshot.text,
    snapshot.mediaUrls,
    snapshot.contentChannel ?? null,
    snapshot.linkId ?? null,
    snapshot.pieceId ?? null,
    snapshot.requireApproval,
    snapshot.dryRun,
  ]);
  if (previous?.fingerprint === fingerprint) return previous;
  return { fingerprint, clientRequestId: createRequestId() };
}
