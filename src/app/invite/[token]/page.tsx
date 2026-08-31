import { prisma } from "@/lib/prisma";
import { AcceptInviteForm } from "@/components/AcceptInviteForm";

export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await prisma.userInvite.findUnique({ where: { token } });

  const invalid = !invite || invite.expiresAt < new Date();

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-bg p-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-bold text-fg">Mati-Ni</h1>
        <p className="text-sm text-muted">초대받은 계정으로 가입합니다.</p>
      </div>

      {invalid ? (
        <div className="card w-80 p-6 text-center text-sm text-neg">
          유효하지 않거나 만료된 초대 링크입니다. 관리자에게 새 링크를 요청하세요.
        </div>
      ) : (
        <AcceptInviteForm token={token} email={invite.email} />
      )}
    </div>
  );
}
