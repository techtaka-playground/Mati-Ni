import { getParties } from "@/lib/parties";
import { getCurrentUserFresh } from "@/lib/session";
import { createParty } from "./actions";
import { PartyTable } from "@/components/PartyTable";

export const dynamic = "force-dynamic";

export default async function PartiesPage() {
  const me = await getCurrentUserFresh();
  if (!me?.canViewParties) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-lg font-semibold text-fg">거래처</h1>
        <div className="card p-4 text-sm text-muted">
          이 탭을 열람할 권한이 없습니다. 관리자에게 문의하세요.
        </div>
      </div>
    );
  }
  const isAdmin = me.role === "admin";
  const parties = await getParties();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold text-fg">거래처</h1>
      </div>

      <form action={createParty} className="card flex items-end gap-3 p-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted">거래처명</label>
          <input
            name="name"
            required
            className="w-56 rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted">사업자등록번호</label>
          <input
            name="bizNo"
            placeholder="000-00-00000"
            className="w-40 rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted">비고</label>
          <input
            name="note"
            className="w-64 rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg"
          />
        </div>
        <button
          type="submit"
          className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover"
        >
          등록
        </button>
      </form>

      <div className="card overflow-x-auto p-4">
        <PartyTable
          parties={parties.map((p) => ({
            id: p.id,
            code: p.code,
            name: p.name,
            bizNo: p.bizNo,
            contactName: p.contactName,
            contactPhone: p.contactPhone,
            email: p.email,
            note: p.note,
            source: p.source,
          }))}
          isAdmin={isAdmin}
        />

        {parties.length === 0 && (
          <div className="py-8 text-center text-sm text-muted">등록된 거래처가 없습니다.</div>
        )}
      </div>
    </div>
  );
}
