import type { PlatformRecipe } from "./types";
import { instagramRecipe } from "./instagram";
import { naverBlogRecipe } from "./naverBlog";
import { threadsRecipe } from "./threads";
import { tiktokRecipe } from "./tiktok";
import { xRecipe } from "./x";

const RECIPES: Record<string, PlatformRecipe> = { THREADS: threadsRecipe, X: xRecipe, INSTAGRAM: instagramRecipe, TIKTOK: tiktokRecipe, NAVER_BLOG: naverBlogRecipe };

export function getRecipe(platform: string): PlatformRecipe | null {
  return RECIPES[platform] ?? null;
}
export const SUPPORTED_PLATFORMS = Object.keys(RECIPES);
export type { PlatformRecipe, RecipeHelpers, SessionCheck } from "./types";
