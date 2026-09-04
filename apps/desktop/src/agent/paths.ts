import os from "node:os";
import path from "node:path";

/** 쓰기 가능한 경로를 한 곳에서 계산 (blogautomcp app-paths.ts 계승). Electron 이면 userData, 아니면 ~/.automoney */
export function userDataRoot(): string {
  if (process.env.AUTOMONEY_USER_DATA) return process.env.AUTOMONEY_USER_DATA;
  return path.join(os.homedir(), ".automoney");
}
export const configPath = () => path.join(userDataRoot(), "config.json");
export const spacesRoot = () => path.join(userDataRoot(), "spaces");
export const logsDir = () => path.join(userDataRoot(), "logs");
export const spaceDir = (spaceId: string) => path.join(spacesRoot(), spaceId.replace(/[^A-Za-z0-9_-]/g, "_"));
export const spaceProfileDir = (spaceId: string) => path.join(spaceDir(spaceId), "profile");
export const spaceLockPath = (spaceId: string) => path.join(spaceDir(spaceId), "space.lock");
export const spaceHistoryPath = (spaceId: string) => path.join(spaceDir(spaceId), "history.jsonl");
export const spaceMetaPath = (spaceId: string) => path.join(spaceDir(spaceId), "meta.json");
