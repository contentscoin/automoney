/** latest*.yml 의 `- url: <파일명>` 목록에서 원하는 확장자 하나를 고른다. */
export function pickAsset(yaml: string, pick: RegExp): string | null {
  const urls = Array.from(yaml.matchAll(/^\s*-\s*url:\s*(\S+)\s*$/gm), (m) => m[1]!);
  return urls.find((u) => pick.test(u)) ?? null;
}
