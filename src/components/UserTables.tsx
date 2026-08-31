"use client";

import { useState } from "react";
import { DeleteButton } from "@/components/DeleteButton";
import { CopyLinkButton } from "@/components/CopyLinkButton";
import { SortableTh } from "@/components/SortableTh";
import { sortRowsBy, toggleSort, type SortState, type SortValue } from "@/lib/tableSort";
import { PERMISSION_FIELDS, PERMISSION_LABELS, type PermissionField } from "@/lib/permissions";
import { togglePermission, setUserRole, deleteUser, deleteInvite } from "@/app/(app)/users/actions";

// 사용자 관리 화면의 두 표를 클라이언트 컴포넌트로 뽑았다 — 열 정렬 때문이다(페이지는 서버
// 컴포넌트라 useState를 쓸 수 없다). 권한 변경은 그대로 Server Action <form>이다.
//
// 탭별 권한이 6개로 늘면서(2026-08-27) 칸마다 열을 따로 두면 표가 너무 넓어져서, "권한" 한
// 칸에 짧은 배지를 나란히 두는 방식으로 바꿨다 — 개별 권한 정렬은 포기하는 대신 한눈에
// 훑어보기 쉽게 했다.

export type InviteRow = {
  id: string;
  email: string;
  role: string;
  token: string;
  expiresAtStr: string; // 서버에서 포맷해서 넘긴다(Date를 클라이언트로 보내지 않는다)
} & Record<PermissionField, boolean>;

type InviteSortKey = "email" | "role" | "expiresAtStr";

function PermissionBadges({ row }: { row: Record<PermissionField, boolean> }) {
  return (
    <div className="flex flex-wrap gap-1">
      {PERMISSION_FIELDS.map((field) => (
        <span
          key={field}
          className={`rounded-md px-1.5 py-0.5 text-xs ${
            row[field] ? "bg-pos/10 text-pos" : "bg-gray-95 text-muted"
          }`}
        >
          {PERMISSION_LABELS[field]}
        </span>
      ))}
    </div>
  );
}

export function InviteTable({ invites, appUrl }: { invites: InviteRow[]; appUrl: string }) {
  const [sort, setSort] = useState<SortState<InviteSortKey>>(null);
  const onSort = (k: InviteSortKey) => setSort((prev) => toggleSort(prev, k));
  const sorted = sortRowsBy(invites, sort, (r, k): SortValue => {
    // 화면에 보이는 글자로 정렬한다 — "admin"/"user"로 정렬하면 화면의 "관리자/일반" 순서와 어긋난다.
    if (k === "role") return r.role === "admin" ? "관리자" : "일반";
    return r[k];
  });

  return (
    <table className="w-full min-w-[720px] text-sm">
      <thead>
        <tr className="border-b border-border text-left text-xs text-muted">
          <SortableTh label="이메일" sortKey="email" state={sort} onSort={onSort} />
          <SortableTh label="권한" sortKey="role" state={sort} onSort={onSort} />
          {/* 탭별 열람 권한·초대 링크·취소는 정렬 대상이 아니다. */}
          <th className="py-2 pr-3">탭 열람</th>
          <th className="py-2 pr-3">초대 링크</th>
          <SortableTh label="만료" sortKey="expiresAtStr" state={sort} onSort={onSort} />
          <th className="py-2 pr-2 text-right">취소</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((inv) => (
          <tr key={inv.id} className="border-b border-border/60">
            <td className="py-2 pr-3 text-fg">{inv.email}</td>
            <td className="py-2 pr-3 text-muted">{inv.role === "admin" ? "관리자" : "일반"}</td>
            <td className="py-2 pr-3">
              <PermissionBadges row={inv} />
            </td>
            <td className="py-2 pr-3">
              <CopyLinkButton url={`${appUrl}/invite/${inv.token}`} />
            </td>
            <td className="py-2 pr-3 whitespace-nowrap num text-muted">{inv.expiresAtStr}</td>
            <td className="py-2 pr-2 text-right">
              <DeleteButton action={deleteInvite} id={inv.id} confirmMessage={`"${inv.email}" 초대를 취소할까요?`} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export type AccountRow = {
  id: string;
  email: string;
  role: string;
  createdAtStr: string;
} & Record<PermissionField, boolean>;

type AccountSortKey = "email" | "role" | "createdAtStr";

export function AccountTable({ users, myUserId }: { users: AccountRow[]; myUserId: string }) {
  const [sort, setSort] = useState<SortState<AccountSortKey>>(null);
  const onSort = (k: AccountSortKey) => setSort((prev) => toggleSort(prev, k));
  const sorted = sortRowsBy(users, sort, (r, k): SortValue => {
    if (k === "role") return r.role === "admin" ? "관리자" : "일반";
    return r[k];
  });

  return (
    <table className="w-full min-w-[720px] text-sm">
      <thead>
        <tr className="border-b border-border text-left text-xs text-muted">
          <SortableTh label="이메일" sortKey="email" state={sort} onSort={onSort} />
          <SortableTh label="권한" sortKey="role" state={sort} onSort={onSort} />
          {/* 탭별 열람 권한·삭제는 버튼/배지 열이라 정렬 대상이 아니다. */}
          <th className="py-2 pr-3">탭 열람 (클릭해서 전환)</th>
          <SortableTh label="생성일" sortKey="createdAtStr" state={sort} onSort={onSort} />
          <th className="py-2 pr-2 text-right">삭제</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((u) => (
          <tr key={u.id} className="border-b border-border/60">
            <td className="py-2 pr-3 text-fg">
              {u.email} {u.id === myUserId && <span className="text-xs text-muted">(나)</span>}
            </td>
            <td className="py-2 pr-3">
              <form action={setUserRole} className="flex items-center gap-1">
                <input type="hidden" name="id" value={u.id} />
                <select
                  name="role"
                  defaultValue={u.role}
                  className="rounded-md border border-border bg-surface px-1.5 py-1 text-xs text-fg"
                >
                  <option value="user">일반</option>
                  <option value="admin">관리자</option>
                </select>
                <button
                  type="submit"
                  className="rounded-md bg-gray-95 px-2 py-1 text-xs text-fg hover:bg-gray-90"
                >
                  변경
                </button>
              </form>
            </td>
            <td className="py-2 pr-3">
              <div className="flex flex-wrap gap-1">
                {PERMISSION_FIELDS.map((field) => (
                  <form key={field} action={togglePermission}>
                    <input type="hidden" name="id" value={u.id} />
                    <input type="hidden" name="field" value={field} />
                    <button
                      type="submit"
                      className={`rounded-md px-1.5 py-0.5 text-xs font-medium ${
                        u[field] ? "bg-pos/10 text-pos" : "bg-gray-95 text-muted"
                      }`}
                    >
                      {PERMISSION_LABELS[field]}
                    </button>
                  </form>
                ))}
              </div>
            </td>
            <td className="py-2 pr-3 whitespace-nowrap num text-muted">{u.createdAtStr}</td>
            <td className="py-2 pr-2 text-right">
              <DeleteButton
                action={deleteUser}
                id={u.id}
                confirmMessage={`"${u.email}" 계정을 삭제할까요?`}
                inUseMessage="본인 계정이거나 마지막 관리자 계정이라 삭제할 수 없습니다."
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
