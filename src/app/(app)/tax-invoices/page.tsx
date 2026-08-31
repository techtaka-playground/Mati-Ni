import { TaxInvoiceSearchForm } from "@/components/TaxInvoiceSearchForm";
import { getCurrentUserFresh } from "@/lib/session";
import { getParties } from "@/lib/parties";

export const dynamic = "force-dynamic";

export default async function TaxInvoicesPage() {
  const user = await getCurrentUserFresh();
  // 관세전표로 등록할 때 고를 거래처 목록. **거래처 마스터에 이미 있는 것만** 고를 수 있게
  // 하려고 서버에서 미리 내려준다(화면에서 새로 만들지 않는다).
  const parties = await getParties();

  return (
    <div className="flex flex-col gap-6">
      {user?.canViewTaxInvoices ? (
        // 엑셀 업로드 버튼은 관리자에게만 보인다(서버 액션에서도 다시 막는다).
        <TaxInvoiceSearchForm
          isAdmin={user.role === "admin"}
          parties={parties.map((p) => ({ id: p.id, code: p.code, name: p.name }))}
        />
      ) : (
        <>
          <h1 className="text-lg font-semibold text-fg">세금계산서</h1>
          <div className="card p-4 text-sm text-muted">
            이 탭을 열람할 권한이 없습니다. 관리자에게 문의하세요.
          </div>
        </>
      )}
    </div>
  );
}
