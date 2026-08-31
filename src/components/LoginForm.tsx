"use client";

import { useState, useTransition } from "react";
import { login } from "@/app/login/actions";

export function LoginForm({ initialEmail = "" }: { initialEmail?: string }) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(!!initialEmail);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await login({ email, password, remember });
      if (!result.ok) setError(result.message);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="card flex w-80 flex-col gap-4 p-7">
      <div className="flex flex-col gap-1.5">
        <label className="text-sm text-gray-30">이메일</label>
        <input
          type="email"
          required
          autoFocus={!initialEmail}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="h-12 rounded-xl border border-border bg-surface px-3.5 text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-sm text-gray-30">비밀번호</label>
        <input
          type="password"
          required
          autoFocus={!!initialEmail}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="h-12 rounded-xl border border-border bg-surface px-3.5 text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
        />
      </div>
      <label className="flex items-center gap-1.5 text-sm text-muted">
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
          className="h-4 w-4 rounded accent-accent"
        />
        이메일 저장
      </label>
      {error && <div className="text-sm text-neg">{error}</div>}
      <button
        type="submit"
        disabled={pending}
        className="h-12 rounded-xl bg-accent text-base font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-50"
      >
        {pending ? "로그인 중..." : "로그인"}
      </button>
    </form>
  );
}
