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
