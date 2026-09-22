export const PUBLISH_PROTOCOL_VERSION = 2;

/**
 * Live publishing is fail-closed. Dry-runs remain available while the switch is
 * off so a deployment can verify the complete workflow before enabling side
 * effects.
 */
export function livePublishEnabled(): boolean {
  return /^(?:1|true|yes|on)$/i.test(process.env.LIVE_PUBLISH_ENABLED?.trim() ?? "");
}
