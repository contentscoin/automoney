"use client";

import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/Badge";
import { KYC_LABEL, ROLE_LABEL, dateTime } from "@/lib/format";

export default function SuperUsersPage() {
  const users = useQuery(api.users.listTeam, {});
  const setRole = useMutation(api.users.setRole);
  const setStatus = useMutation(api.users.setStatus);
  const assignAdmin = useMutation(api.users.assignAdmin);
  const admins = users?.filter((u) => u.role === "ADMIN") ?? [];
  return (
    <div>
      <h1 className="text-xl font-bold">유저·권한</h1>
      <div className="mt-4 overflow-x-auto">
        <table className="table">
          <thead><tr><th>이메일</th><th>이름</th><th>역할</th><th>소속 총판</th><th>상태</th><th>KYC</th><th>가입일</th></tr></thead>
          <tbody>
            {users?.map((u) => (
              <tr key={u._id}>
                <td>{u.email}</td>
                <td>{u.name}</td>
                <td>
                  <select className="input !w-auto !py-1 text-xs" value={u.role} onChange={(e) => setRole({ userId: u._id, role: e.target.value as "USER" | "ADMIN" | "SUPER_ADMIN" })}>
                    {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </td>
                <td>
                  {u.role === "USER" ? (
                    <select className="input !w-auto !py-1 text-xs" value={u.parentAdminId ?? ""} onChange={(e) => assignAdmin({ userId: u._id, adminId: (e.target.value || undefined) as Id<"users"> | undefined })}>
                      <option value="">(없음)</option>
                      {admins.map((a) => <option key={a._id} value={a._id}>{a.name || a.email}</option>)}
                    </select>
                  ) : "-"}
                </td>
                <td>
                  <select className="input !w-auto !py-1 text-xs" value={u.status} onChange={(e) => setStatus({ userId: u._id, status: e.target.value as "PENDING" | "ACTIVE" | "SUSPENDED" })}>
                    <option value="ACTIVE">활성</option><option value="SUSPENDED">정지</option><option value="PENDING">대기</option>
                  </select>
                </td>
                <td>{u.kycStatus ? <Badge value={u.kycStatus} label={KYC_LABEL[u.kycStatus]} /> : <span className="text-xs text-stone-400">미등록</span>}</td>
                <td className="text-xs">{dateTime(u.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
