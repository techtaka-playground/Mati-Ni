import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { LoginForm } from "@/components/LoginForm";
import { FirstAdminForm } from "@/components/FirstAdminForm";
import { REMEMBER_EMAIL_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const [count, store] = await Promise.all([prisma.user.count(), cookies()]);
  const rememberedEmail = store.get(REMEMBER_EMAIL_COOKIE)?.value ?? "";

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-bg p-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-bold text-fg">Mati-Ni</h1>
        <p className="text-sm font-semibold text-accent">Sol made it</p>
      </div>

      {count === 0 ? (
        <div className="flex flex-col items-center gap-2">
          <p className="text-sm text-muted">첫 실행입니다 — 관리자 계정을 만들어주세요.</p>
          <FirstAdminForm />
        </div>
      ) : (
        <LoginForm initialEmail={rememberedEmail} />
      )}
    </div>
  );
}
