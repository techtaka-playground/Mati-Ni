import { requireLoggedIn } from "@/lib/session";
import { changePasswordAction } from "./actions";

const ERROR_MESSAGE: Record<string, string> = {
  current: "현재 비밀번호가 올바르지 않습니다.",
  short: "새 비밀번호는 8자 이상이어야 합니다.",
  mismatch: "새 비밀번호 확인이 일치하지 않습니다.",
};

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; done?: string }>;
}) {
  const user = await requireLoggedIn();
  const { error, done } = await searchParams;

  return (
    <div className="max-w-sm">
      <h1 className="mb-1 text-xl font-semibold">계정</h1>
      <p className="mb-6 text-sm text-muted">{user.email}</p>

      <form action={changePasswordAction} className="card flex flex-col gap-4 p-7">
        <h2 className="text-sm font-medium text-gray-30">비밀번호 변경</h2>
        {error && ERROR_MESSAGE[error] && (
          <p className="rounded-xl bg-red-50 px-3 py-2.5 text-sm text-neg">
            {ERROR_MESSAGE[error]}
          </p>
        )}
        {done && (
          <p className="rounded-xl bg-pos/10 px-3 py-2.5 text-sm text-pos">변경되었습니다.</p>
        )}
        <label className="flex flex-col gap-1.5 text-sm text-gray-30">
          현재 비밀번호
          <input
            type="password"
            name="currentPassword"
            required
            autoComplete="current-password"
            className="h-12 rounded-xl border border-border bg-surface px-3.5 text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm text-gray-30">
          새 비밀번호 (8자 이상)
          <input
            type="password"
            name="newPassword"
            required
            minLength={8}
            autoComplete="new-password"
            className="h-12 rounded-xl border border-border bg-surface px-3.5 text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm text-gray-30">
          새 비밀번호 확인
          <input
            type="password"
            name="newPasswordConfirm"
            required
            minLength={8}
            autoComplete="new-password"
            className="h-12 rounded-xl border border-border bg-surface px-3.5 text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
          />
        </label>
        <button
          type="submit"
          className="h-12 rounded-xl bg-accent text-base font-semibold text-accent-fg hover:bg-accent-hover"
        >
          비밀번호 변경
        </button>
      </form>
    </div>
  );
}
