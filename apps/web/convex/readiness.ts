import { DEVICE_ONLINE_MS } from "@automoney/shared";
import { v } from "convex/values";
import { query } from "./_generated/server";
import { MIN_ADMIN_MATERIAL_DESKTOP_VERSION, MIN_CONTENT_DESKTOP_VERSION, versionAtLeast } from "./content";
import { MIN_PUBLISH_DESKTOP_VERSION } from "./agent";
import { isDemoMarketingLink, partnerLinkMode } from "./lib/marketingLinkPolicy";
import { metaLivePublishAvailable } from "./lib/meta";
import { publicSiteOrigin } from "./lib/publicUrl";
import { livePublishEnabled } from "./lib/publishPolicy";
import { requireUser } from "./lib/rbac";

type ReadinessIssue = { code: string; message: string; href: string; scope: "all" | "live" | "ai" };
const issue = (code: string, message: string, href = "/dashboard/connections", scope: ReadinessIssue["scope"] = "all"): ReadinessIssue => ({ code, message, href, scope });

function publicFlags() {
  return {
    livePublishEnabled: livePublishEnabled(),
    partnerMode: partnerLinkMode(),
    publicSiteConfigured: publicSiteOrigin() !== null,
    metaConfigured: metaLivePublishAvailable(),
    minimumDesktopVersion: MIN_ADMIN_MATERIAL_DESKTOP_VERSION,
  };
}

/** Deployment capabilities only: never return credentials, URLs, or account identifiers. */
export const getPublic = query({ args: {}, handler: () => publicFlags() });

/** Current capabilities are shared by connection, publishing and schedule screens. */
export const getMine = query({
  // A changing key reevaluates heartbeat expiry after an offline PC stops writing.
  // The query always uses server time, never this caller-supplied value.
  args: { refreshKey: v.optional(v.number()) },
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const checkedAt = Date.now();
    const flags = publicFlags();
    const devices = await ctx.db.query("devices").withIndex("by_user", (q) => q.eq("userId", user._id).eq("status", "ACTIVE")).collect();
    const spaces = await ctx.db.query("spaces").withIndex("by_user", (q) => q.eq("userId", user._id)).collect();
    const links = await ctx.db.query("marketingLinks").withIndex("by_user", (q) => q.eq("userId", user._id)).collect();
    const active = devices.sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))[0];
    const online = (lastSeenAt?: number) => !!lastSeenAt && checkedAt - lastSeenAt < DEVICE_ONLINE_MS;
    const snapshot = active?.snapshot as { codexInstalled?: boolean; codexLoggedIn?: boolean } | undefined;
    const device = active ? {
      id: active._id, name: active.name, online: online(active.lastSeenAt), appVersion: active.appVersion,
      compatible: versionAtLeast(active.appVersion, flags.minimumDesktopVersion),
      codexInstalled: snapshot?.codexInstalled === true,
      codexLoggedIn: snapshot?.codexLoggedIn === true,
    } : null;
    const aiMinimum = user.role === "SUPER_ADMIN" ? MIN_ADMIN_MATERIAL_DESKTOP_VERSION : MIN_CONTENT_DESKTOP_VERSION;
    const aiReady = (user.status ?? "ACTIVE") === "ACTIVE" && !!device?.online && versionAtLeast(device.appVersion, aiMinimum) && device.codexInstalled && device.codexLoggedIn;
    const issues: ReadinessIssue[] = [];
    if ((user.status ?? "ACTIVE") !== "ACTIVE") issues.push(issue("ACCOUNT_PENDING", "계정 승인이 완료되어야 게시할 수 있습니다."));
    if (!flags.livePublishEnabled) issues.push(issue("LIVE_PUBLISH_DISABLED", "현재 실제 게시는 준비 중입니다. 콘텐츠 제작과 테스트 실행은 사용할 수 있습니다.", "/dashboard/publish?dryRun=1", "live"));
    if (!flags.publicSiteConfigured) issues.push(issue("PUBLIC_SITE_URL_INVALID", "마케팅 링크의 공개 주소 설정을 운영팀에서 확인해야 합니다.", "/dashboard/links", "live"));
    if (!device) issues.push(issue("DEVICE_REQUIRED", "PC 앱을 설치하고 페어링하세요.", "/dashboard/connections", "ai"));
    else if (!device.online) issues.push(issue("DEVICE_OFFLINE", "페어링한 PC 앱을 실행하고 온라인 상태를 확인하세요.", "/dashboard/connections", "ai"));
    else if (!versionAtLeast(device.appVersion, aiMinimum)) issues.push(issue("DESKTOP_UPDATE_REQUIRED", `콘텐츠 생성에는 PC 앱 ${aiMinimum} 이상이 필요합니다.`, "/dashboard/connections", "ai"));
    else if (!device.codexInstalled) issues.push(issue("CODEX_NOT_INSTALLED", "PC에 Codex CLI를 설치하세요.", "/dashboard/connections#ai", "ai"));
    else if (!device.codexLoggedIn) issues.push(issue("CODEX_LOGIN_REQUIRED", "PC의 Codex 로그인을 완료하세요.", "/dashboard/connections#ai", "ai"));
    const readySpaces = await Promise.all(spaces.map(async (space) => {
      const problems: ReadinessIssue[] = [];
      if ((user.status ?? "ACTIVE") !== "ACTIVE") problems.push(issue("ACCOUNT_PENDING", "계정 승인을 기다리고 있습니다."));
      if (space.sessionState !== "HEALTHY") problems.push(issue(`SPACE_${space.sessionState}`, "게시 계정 로그인과 상태 확인을 완료하세요.", "/dashboard/connections#sns"));
      if (space.lockJobId) problems.push(issue("SPACE_BUSY", "이 계정에서 실행 중인 작업이 끝나면 다시 확인하세요.", "/dashboard/jobs"));
      if (!space.handle?.trim()) problems.push(issue("SPACE_IDENTITY_UNVERIFIED", "게시할 SNS 계정의 핸들을 확인하세요.", "/dashboard/connections#sns"));
      if (space.authMode === "META_API") {
        const account = space.snsAccountId ? await ctx.db.get(space.snsAccountId) : null;
        if (!account || account.userId !== user._id || account.status !== "ACTIVE" || account.tokenExpiresAt <= checkedAt)
          problems.push(issue("META_RECONNECT_REQUIRED", "Meta 계정을 다시 연결하세요.", "/dashboard/spaces"));
        if (!account || !metaLivePublishAvailable(account.mode)) problems.push(issue("META_LIVE_UNAVAILABLE", "이 Meta 연결은 테스트 실행만 가능합니다. 실제 계정을 연결하세요.", "/dashboard/spaces", "live"));
      } else {
        const pc = devices.find((candidate) => candidate._id === space.deviceId);
        if (!pc || !online(pc.lastSeenAt)) problems.push(issue("DEVICE_OFFLINE", "이 계정이 연결된 PC 앱을 실행하세요."));
        else if (!versionAtLeast(pc.appVersion, MIN_PUBLISH_DESKTOP_VERSION)) problems.push(issue("DESKTOP_UPDATE_REQUIRED", `게시에는 PC 앱 ${MIN_PUBLISH_DESKTOP_VERSION} 이상이 필요합니다.`));
      }
      const readyForTest = problems.every((problem) => problem.scope === "live");
      if (!flags.livePublishEnabled) problems.push(issue("LIVE_PUBLISH_DISABLED", "현재 테스트 실행만 사용할 수 있습니다.", "/dashboard/publish?dryRun=1", "live"));
      return { id: space._id, name: space.name, platform: space.platform, authMode: space.authMode ?? "BROWSER", readyForTest, readyForLive: readyForTest && problems.length === 0, issues: problems };
    }));
    const activeLinks = links.filter((link) => link.status === "ACTIVE");
    return {
      checkedAt, ...flags, device, aiReady, issues, spaces: readySpaces,
      links: { liveCount: activeLinks.filter((link) => !isDemoMarketingLink(link)).length, demoCount: activeLinks.filter(isDemoMarketingLink).length },
    };
  },
});
