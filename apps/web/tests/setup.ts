// vitest(Vite) 가 제공하는 import.meta.glob 타입만 최소 선언 (vite 를 직접 의존성으로 두지 않기 위함)
declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

export const modules = import.meta.glob("../convex/**/*.ts");
