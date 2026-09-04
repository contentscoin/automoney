import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import { makeT, setRole, signup } from "./helpers";

describe("onboarding & rbac", () => {
  it("assigns SUPER_ADMIN from env and USER otherwise with a partner code", async () => {
    const t = makeT();
    const owner = await signup(t, "owner@automoney.test");
    const user = await signup(t, "u1@test.com");
    const ownerMe = await owner.as.query(api.users.me, {});
    const userMe = await user.as.query(api.users.me, {});
    expect(ownerMe?.role).toBe("SUPER_ADMIN");
    expect(userMe?.role).toBe("USER");
    expect(userMe?.partnerCode).toHaveLength(10);
  });

  it("consumes a valid invite code and links the user to the admin", async () => {
    const t = makeT();
    const admin = await signup(t, "admin@test.com");
    await setRole(t, admin.userId, "ADMIN");
    const { code } = await admin.as.mutation(api.invites.create, { maxUses: 1 });
    expect(await t.query(api.invites.validate, { code })).toEqual({ valid: true });

    const user = await signup(t, "u2@test.com", { inviteCode: code });
    const me = await user.as.query(api.users.me, {});
    expect(me?.parentAdminId).toBe(admin.userId);
    // 소진된 코드는 더 이상 유효하지 않다
    expect(await t.query(api.invites.validate, { code })).toEqual({ valid: false });
    await expect(signup(t, "u3@test.com", { inviteCode: code })).rejects.toThrow(/초대 코드/);
  });

  it("rejects unknown invite codes", async () => {
    const t = makeT();
    await expect(signup(t, "u4@test.com", { inviteCode: "ZZZZZZZZ" })).rejects.toThrow(/초대 코드/);
  });

  it("enforces role guards", async () => {
    const t = makeT();
    const user = await signup(t, "u5@test.com");
    await expect(user.as.mutation(api.invites.create, {})).rejects.toThrow(/권한/);
    await expect(user.as.query(api.dashboard.superSummary, {})).rejects.toThrow(/권한/);
    await expect(t.query(api.users.me, {})).resolves.toBeNull();
    await expect(t.query(api.links.listMine, {})).rejects.toThrow(/로그인/);
  });

  it("admins only see their own team", async () => {
    const t = makeT();
    const a1 = await signup(t, "a1@test.com");
    const a2 = await signup(t, "a2@test.com");
    await setRole(t, a1.userId, "ADMIN");
    await setRole(t, a2.userId, "ADMIN");
    const c1 = await a1.as.mutation(api.invites.create, {});
    const c2 = await a2.as.mutation(api.invites.create, {});
    const u1 = await signup(t, "t1@test.com", { inviteCode: c1.code });
    await signup(t, "t2@test.com", { inviteCode: c2.code });
    const team = await a1.as.query(api.users.listTeam, {});
    expect(team.map((r) => r._id)).toEqual([u1.userId]);
    expect(team[0]?.email).toMatch(/^t1\*+@test\.com$/);
    await expect(a1.as.query(api.orders.listForUser, { userId: u1.userId })).resolves.toEqual([]);
    const t2 = (await a2.as.query(api.users.listTeam, {}))[0]!;
    await expect(a1.as.query(api.orders.listForUser, { userId: t2._id })).rejects.toThrow(/접근/);
  });
});
