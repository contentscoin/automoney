import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import { makeT } from "./helpers";

describe("password authentication", () => {
  it("returns a normal failed sign-in for an unknown account", async () => {
    const t = makeT();

    const result = await t.action(api.auth.signIn, {
      provider: "password",
      params: {
        flow: "signIn",
        email: "missing@automoney.test",
        password: "Password1234",
      },
    });

    expect(result).toEqual({ tokens: null });
  });
});
