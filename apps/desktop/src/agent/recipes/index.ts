import type { PlatformRecipe } from "./types";
import { threadsRecipe } from "./threads";
import { xRecipe } from "./x";

const RECIPES: Record<string, PlatformRecipe> = { THREADS: threadsRecipe, X: xRecipe };

export function getRecipe(platform: string): PlatformRecipe | null {
  return RECIPES[platform] ?? null;
}
export const SUPPORTED_PLATFORMS = Object.keys(RECIPES);
export type { PlatformRecipe, RecipeHelpers, SessionCheck } from "./types";
