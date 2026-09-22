import { Password, type PasswordConfig } from "@convex-dev/auth/providers/Password";
import type { ConvexCredentialsUserConfig } from "@convex-dev/auth/providers/ConvexCredentials";
import { convexAuth } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import { normalizeCode } from "@automoney/shared";
import type { DataModel } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { provisionNewUser } from "./lib/onboarding";

function safePasswordProvider(config: PasswordConfig<DataModel>) {
  const provider = Password<DataModel>(config);
  const options = (
    provider as unknown as {
      options: { authorize: ConvexCredentialsUserConfig<DataModel>["authorize"] };
    }
  ).options;
  const authorize = options.authorize;

  // @convex-dev/auth 0.0.95 throws its internal lookup errors before the
  // Password provider can turn an unknown account or bad secret into a normal
  // failed sign-in. Keep invalid credentials on the expected null result path.
  options.authorize = async (params, ctx) => {
    try {
      return await authorize(params, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes("InvalidAccountId") ||
        message.includes("InvalidSecret") ||
        message.includes("TooManyFailedAttempts") ||
        message.includes("Invalid credentials")
      ) {
        return null;
      }
      throw error;
    }
  };

  return provider;
}

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    safePasswordProvider({
      profile(params) {
        const email = String(params.email ?? "")
          .trim()
          .toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          throw new ConvexError({ code: "INVALID_ARGUMENT", message: "이메일 형식이 올바르지 않습니다." });
        }
        const name = typeof params.name === "string" ? params.name.trim().slice(0, 40) : undefined;
        const rawInvite = typeof params.inviteCode === "string" ? normalizeCode(params.inviteCode) : "";
        return {
          email,
          name: name || undefined,
          inviteCode: rawInvite || undefined,
        };
      },
      validatePasswordRequirements(password) {
        if (password.length < 8 || !/\d/.test(password) || !/[A-Za-z]/.test(password)) {
          throw new ConvexError({
            code: "INVALID_ARGUMENT",
            message: "비밀번호는 8자 이상, 영문과 숫자를 포함해야 합니다.",
          });
        }
      },
    }),
  ],
  callbacks: {
    async afterUserCreatedOrUpdated(rawCtx, args) {
      if (args.existingUserId) return;
      // Convex Auth 는 AnyDataModel 로 ctx 를 넘기므로 앱 스키마 타입으로 좁힌다.
      await provisionNewUser(rawCtx as unknown as MutationCtx, args.userId);
    },
  },
});
