"use client";

import { useState, useTransition } from "react";
import { acceptInvite } from "@/app/invite/[token]/actions";

export function AcceptInviteForm({ token, email }: { token: string; email: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await acceptInvite({ token, password, confirm });
      if (!result.ok) setError(result.message);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="card flex w-80 flex-col gap-4 p-7">
      <div className="flex flex-col gap-1.5">
        <label className="text-sm text-gray-30">이메일</label>
        <div className="flex h-12 items-center rounded-xl border border-border bg-gray-95 px-3.5 text-base text-muted">
          {email}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-sm text-gray-30">비밀번호 (8자 이상)</label>
        <input
          type="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="h-12 rounded-xl border border-border bg-surface px-3.5 text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-sm text-gray-30">비밀번호 확인</label>
        <input
          type="password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="h-12 rounded-xl border border-border bg-surface px-3.5 text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
        />
      </div>
      {error && <div className="text-sm text-neg">{error}</div>}
      <button
        type="submit"
        disabled={pending}
        className="h-12 rounded-xl bg-accent text-base font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-50"
      >
        {pending ? "가입 처리 중..." : "가입 완료"}
      </button>
    </form>
  );
}
