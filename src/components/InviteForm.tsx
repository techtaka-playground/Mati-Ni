"use client";

import { useRef, useState, useTransition } from "react";
import { createInvite } from "@/app/(app)/users/actions";
import { PERMISSION_FIELDS, PERMISSION_LABELS } from "@/lib/permissions";

export function InviteForm() {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await createInvite(formData);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      formRef.current?.reset();
    });
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="card flex flex-wrap items-end gap-3 p-4">
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted">초대할 이메일</label>
        <input
          type="email"
          name="email"
          required
          className="w-56 rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted">권한</label>
        <select
          name="role"
          defaultValue="user"
          className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg"
        >
          <option value="user">일반</option>
          <option value="admin">관리자</option>
        </select>
      </div>
      {PERMISSION_FIELDS.map((field) => (
        <label key={field} className="flex items-center gap-1.5 pb-1.5 text-sm text-fg">
          <input type="checkbox" name={field} />
          {PERMISSION_LABELS[field]}
        </label>
      ))}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
      >
        {pending ? "생성 중..." : "초대 링크 생성"}
      </button>
      {error && <div className="text-sm text-neg">{error}</div>}
    </form>
  );
}
