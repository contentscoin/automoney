/** Resolve the public HTTPS origin used in links that will be posted externally. */
export function publicSiteOrigin(): string | null {
  const raw = process.env.SITE_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function marketingRedirectUrl(shortCode: string): string | null {
  const origin = publicSiteOrigin();
  if (!origin) return null;
  return `${origin}/r/${encodeURIComponent(shortCode)}`;
}
