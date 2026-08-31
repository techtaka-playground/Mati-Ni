"use client";

import { useState } from "react";
import { DeleteButton } from "@/components/DeleteButton";
import { IconCheckCircle, IconClock } from "@/components/icons";
import { createGroup, deleteGroup, addGroupMember, removeGroupMember } from "@/app/(app)/users/actions";

type GroupMember = { id: string; email: string };
type Group = { id: string; name: string | null; members: GroupMember[] };

// 이메일 그룹 관리 — "사용자 관리" 제목과 같은 줄, 왼쪽에 토글 버튼을 두고 누르면 팝업이
// 아니라 그 아래에 내용이 그대로 펼쳐진다(2026-08-31, 팝업 대신 인라인으로 바꿔달라는
// 요청에 따름). children으로 받은 제목을 버튼 옆에 그대로 이어 붙인다.
export function EmailGroupManager({
  groups,
  registeredEmails,
  children,
}: {
  groups: Group[];
  registeredEmails: string[];
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const registered = new Set(registeredEmails);

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        {children}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className={`rounded-md border px-4 py-1.5 text-sm transition-colors ${
            open
              ? "border-accent bg-accent-soft text-accent-hover"
              : "border-border bg-surface text-fg hover:bg-gray-95"
          }`}
        >
          이메일 그룹
        </button>
      </div>

      {open && (
        <div className="card flex flex-col gap-5 p-6">
          <form action={createGroup} className="flex flex-wrap items-end gap-3 rounded-xl border border-border p-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted">그룹 이름 (선택)</label>
              <input
                name="name"
                placeholder="예: 물류팀"
                className="w-56 rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg"
              />
            </div>
            <button
              type="submit"
              className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover"
            >
              새 그룹 만들기
            </button>
          </form>

          <div className="flex flex-col gap-4">
            {groups.map((g) => (
              <div key={g.id} className="rounded-xl border border-border p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div className="text-sm font-medium text-fg">{g.name || "(이름 없음)"}</div>
                  <DeleteButton
                    action={deleteGroup}
                    id={g.id}
                    confirmMessage={`"${g.name || "이름 없음"}" 그룹을 삭제할까요? 멤버 ${g.members.length}명도 함께 지워집니다.`}
                    label="그룹 삭제"
                  />
                </div>

                <table className="mb-3 w-full text-sm">
                  <tbody>
                    {g.members.map((m) => (
                      <tr key={m.id} className="border-b border-border/60 last:border-0">
                        <td className="py-2 pr-3 text-fg">{m.email}</td>
                        <td className="py-2 pr-3 text-xs">
                          {registered.has(m.email) ? (
                            <span className="flex items-center gap-1 text-pos">
                              <IconCheckCircle className="h-3.5 w-3.5" />
                              가입됨
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-muted">
                              <IconClock className="h-3.5 w-3.5" />
                              미가입
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-2 text-right">
                          <DeleteButton
                            action={removeGroupMember}
                            id={m.id}
                            confirmMessage={`"${m.email}"을(를) 그룹에서 제거할까요?`}
                            label="제거"
                          />
                        </td>
                      </tr>
                    ))}
                    {g.members.length === 0 && (
                      <tr>
                        <td colSpan={3} className="py-2 text-center text-xs text-muted">
                          멤버가 없습니다.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>

                <form action={addGroupMember} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="groupId" value={g.id} />
                  <input
                    type="email"
                    name="email"
                    required
                    autoComplete="off"
                    placeholder="추가할 이메일 (가입 여부 무관)"
                    className="w-64 rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg"
                  />
                  <button type="submit" className="rounded-md bg-gray-95 px-3 py-1.5 text-sm text-fg hover:bg-gray-90">
                    멤버 추가
                  </button>
                </form>
              </div>
            ))}
            {groups.length === 0 && (
              <div className="rounded-xl border border-border p-6 text-center text-sm text-muted">
                아직 만든 그룹이 없습니다.
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
