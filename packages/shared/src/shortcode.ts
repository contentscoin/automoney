import { SAFE_ALPHABET } from "./constants";

/**
 * 암호학적 난수 기반 코드 생성. 단축 링크·초대 코드·파트너 코드에 공용.
 * WebCrypto(getRandomValues)만 사용해 Convex 런타임과 Node 모두에서 동작.
 */
export function generateCode(length: number, alphabet: string = SAFE_ALPHABET): string {
  if (length <= 0) throw new Error("length must be positive");
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

/** 사용자가 입력한 코드 정규화: 대문자화, 공백/하이픈 제거, 알파벳 외 문자 제거. */
export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .split("")
    .filter((ch) => SAFE_ALPHABET.includes(ch))
    .join("");
}

export function isValidCode(code: string, length: number): boolean {
  if (code.length !== length) return false;
  for (const ch of code) if (!SAFE_ALPHABET.includes(ch)) return false;
  return true;
}

export const SHORT_CODE_LENGTH = 7;
export const INVITE_CODE_LENGTH = 8;
export const PARTNER_CODE_LENGTH = 10;
