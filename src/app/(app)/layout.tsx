import { redirect } from "next/navigation";
import { getCurrentUserFresh } from "@/lib/session";
import { Sidebar } from "@/components/Sidebar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // 세션 쿠키 자체는 stateless지만, 사이드바 메뉴(세금계산서/사용자 관리)는 관리자가
  // 방금 바꾼 권한을 바로 반영해야 하므로 매 요청마다 DB에서 role/canViewTaxInvoices를
  // 다시 읽는다 — SQLite 단일 row 조회라 비용은 무시할 만하다.
  const user = await getCurrentUserFresh();
  if (!user) redirect("/login");

  return (
    <div className="flex min-h-screen">
      <Sidebar user={user} />
      <main className="min-w-0 flex-1 p-8">{children}</main>
    </div>
  );
}
