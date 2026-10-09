import { guessMediaKind, validateContentMedia, type Channel } from "@automoney/shared";

type PublishMediaInput = {
  mediaUrls: string[];
  pieceChannel?: string;
  platform?: string;
};

export function inspectPublishMedia({ mediaUrls, pieceChannel, platform }: PublishMediaInput) {
  const invalidMediaUrls = mediaUrls.filter((url) => !/^https:\/\//i.test(url));
  const shortFormChannel = pieceChannel === "INSTAGRAM_REEL" || pieceChannel === "TIKTOK";
  const requiresVideo = shortFormChannel || platform === "TIKTOK";
  const hasVerifiedVideo = mediaUrls.length === 1 && /^https:\/\//i.test(mediaUrls[0] ?? "") && guessMediaKind(mediaUrls[0] ?? "") === "video";
  const mediaRequired = platform === "INSTAGRAM" || platform === "TIKTOK";
  const contentMediaError = pieceChannel ? validateContentMedia(pieceChannel as Channel, mediaUrls) : null;

  return {
    invalidMediaUrls,
    requiresVideo,
    hasVerifiedVideo,
    contentMediaError,
    mediaInputInvalid: invalidMediaUrls.length > 0
      || (requiresVideo && !hasVerifiedVideo)
      || (mediaRequired && mediaUrls.length === 0)
      || contentMediaError !== null,
  };
}

export function validatePieceMediaEdit(mediaUrls: string[], channel: string): string | null {
  const error = validateContentMedia(channel as Channel, mediaUrls);
  if ((channel === "INSTAGRAM_REEL" || channel === "TIKTOK") && error) {
    return "Reels·TikTok은 정적 이미지를 제거하고 .mp4, .mov, .m4v 또는 .webm 형식의 HTTPS 영상 URL 1개만 입력하세요.";
  }
  if (mediaUrls.length > 10) return "미디어는 최대 10개까지 추가할 수 있습니다.";
  if (mediaUrls.some((url) => !/^https:\/\//i.test(url))) return "미디어 URL은 모두 HTTPS 주소여야 합니다.";
  return null;
}

/** UI hint only. The server repeats these checks before accepting and executing LIVE work. */
export function mediaLivePublishIssue(input: {
  mediaCount: number;
  hasPiece: boolean;
  mediaReady?: boolean;
  mediaApprovalReady?: boolean;
  dryRun?: boolean;
  browserSpace?: boolean;
  mediaVersionCompatible?: boolean;
  minimumMediaVersion?: string;
}): string | null {
  if (input.dryRun || input.mediaCount === 0) return null;
  if (!input.hasPiece) return "이미지·영상의 실제 게시에는 고정·승인된 콘텐츠가 필요합니다. 내 콘텐츠에 저장한 뒤 미디어 고정과 검수를 완료하세요.";
  if (input.mediaReady !== true) return "선택한 콘텐츠의 미디어 고정이 완료되지 않았습니다. 내 콘텐츠에서 파일을 고정하고 다시 승인하세요.";
  if (input.mediaApprovalReady !== true) return "고정된 미디어의 승인 기록을 확인할 수 없습니다. 내 콘텐츠에서 내용을 수정·저장한 뒤 파일을 다시 검수하고 승인하세요.";
  if (input.browserSpace && input.mediaVersionCompatible !== true) return `이미지·영상의 실제 게시에는 연결된 PC 앱 ${input.minimumMediaVersion ?? "0.1.18"} 이상이 필요합니다. 연결 관리에서 업데이트를 확인하세요.`;
  return null;
}
