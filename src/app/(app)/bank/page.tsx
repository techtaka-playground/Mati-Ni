import { BankLogSearchForm } from "@/components/BankLogSearchForm";
import { getCurrentUserFresh } from "@/lib/session";
import { getParties } from "@/lib/parties";

export const dynamic = "force-dynamic";

export default async function BankPage() {
  const user = await getCurrentUserFresh();
  // 송금인/적요에 거래처를 지정할 때 고를 목록 — 거래처 마스터에 있는 것만 고를 수 있다.
  const parties = await getParties();

  return (
    <div className="flex flex-col gap-6">
      {user?.canViewBankLogs ? (
        // 제목·업데이트 시각은 컴포넌트 안에서 그린다(세금계산서 화면과 같은 이유 — 조회
        // 전용 안내문 대신 마지막으로 불러온 시각만 보여준다, 2026-08-27).
        // corpName은 거래확인서 상단 "고객명"에 찍힌다 — .env의 BAROBILL_CORPNAME.
        <BankLogSearchForm
          corpName={process.env.BAROBILL_CORPNAME ?? ""}
          parties={parties.map((p) => ({ id: p.id, code: p.code, name: p.name }))}
        />
      ) : (
        <>
          <h1 className="text-lg font-semibold text-fg">입출금내역</h1>
          <div className="card p-4 text-sm text-muted">
            이 탭을 열람할 권한이 없습니다. 관리자에게 문의하세요.
          </div>
        </>
      )}
    </div>
  );
}
