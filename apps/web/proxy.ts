import { convexAuthNextjsMiddleware, createRouteMatcher, nextjsMiddlewareRedirect } from "@convex-dev/auth/nextjs/server";

const isSignInPage = createRouteMatcher(["/signin", "/signup"]);
const isProtected = createRouteMatcher(["/dashboard(.*)", "/admin(.*)", "/super(.*)"]);

export default convexAuthNextjsMiddleware(async (request, { convexAuth }) => {
  const authed = await convexAuth.isAuthenticated();
  if (isSignInPage(request) && authed) return nextjsMiddlewareRedirect(request, "/dashboard");
  if (isProtected(request) && !authed) return nextjsMiddlewareRedirect(request, "/signin");
});

export const config = {
  matcher: ["/((?!.*\\..*|_next|r/).*)", "/", "/(api|trpc)(.*)"],
};
