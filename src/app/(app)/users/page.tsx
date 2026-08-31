import { prisma } from "@/lib/prisma";
import { getCurrentUserFresh } from "@/lib/session";
import { getAppUrl } from "@/lib/appUrl";
import { formatDate } from "@/lib/format";
import { InviteForm } from "@/components/InviteForm";
import { InviteTable, AccountTable } from "@/components/UserTables";
import { EmailGroupManager } from "@/components/EmailGroupManager";
import { PERMISSION_FIELDS, type PermissionField } from "@/lib/permissions";

function pickPermissions(row: Record<PermissionField, boolean>): Record<PermissionField, boolean> {
  return Object.fromEntries(PERMISSION_FIELDS.map((f) => [f, row[f]])) as Record<PermissionField, boolean>;
}

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const me = await getCurrentUserFresh();

  if (!me || me.role !== "admin") {
    return (
      <div className="card p-4 text-sm text-muted">
        이 화면은 관리자만 접근할 수 있습니다.
      </div>
    );
  }

  const [users, invites, groups] = await Promise.all([
    prisma.user.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.userInvite.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.emailAccessGroup.findMany({
      include: { members: { orderBy: { email: "asc" } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const appUrl = getAppUrl();
  const registeredEmails = new Set(users.map((u) => u.email));

  return (
    <div className="flex flex-col gap-6">
      <EmailGroupManager
        groups={groups.map((g) => ({ id: g.id, name: g.name, members: g.members }))}
        registeredEmails={Array.from(registeredEmails)}
      >
        <h1 className="text-lg font-semibold text-fg">사용자 관리</h1>
      </EmailGroupManager>

      <InviteForm />

      {invites.length > 0 && (
        <div className="card overflow-x-auto p-4">
          <div className="mb-2 text-sm font-medium text-fg">대기 중인 초대</div>
          <InviteTable
            invites={invites.map((inv) => ({
              id: inv.id,
              email: inv.email,
              role: inv.role,
              ...pickPermissions(inv),
              token: inv.token,
              expiresAtStr: formatDate(inv.expiresAt),
            }))}
            appUrl={appUrl}
          />
        </div>
      )}

      <div className="card overflow-x-auto p-4">
        <AccountTable
          users={users.map((u) => ({
            id: u.id,
            email: u.email,
            role: u.role,
            ...pickPermissions(u),
            createdAtStr: formatDate(u.createdAt),
          }))}
          myUserId={me.userId}
        />
      </div>
    </div>
  );
}
