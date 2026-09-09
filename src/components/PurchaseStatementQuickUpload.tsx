"use client";

import { forwardRef, useImperativeHandle, useState, useTransition } from "react";
import { createPurchase } from "@/app/(app)/purchases/actions";
import { ensurePartyByName } from "@/app/(app)/parties/actions";
import { commaInput, formatAmount, numOf } from "@/lib/format";
import type { ExtractedPurchaseStatementSmart } from "@/app/(app)/purchases/actions";

type SaleOption = { id: string; blNo: string; dateStr: string; partyName: string };

// 일반전표 수기기입(VoucherQuickEntry)과 같은 목록 — 해외 파트너 명세서(statementOfAccountParser)
// 는 늘 이 중 하나로 찍혀 있고, 인식된 통화가 다르더라도(예: 문서엔 USD인데 실제로는 AUD로
// 처리해야 하는 경우) 아래에서 직접 바꿀 수 있다.
const CURRENCIES = ["KRW", "USD", "JPY", "EUR", "CNY", "AUD", "HKD", "GBP"] as const;

// matchedBlNo: 실제로 매출과 일치한 번호(House 또는 Master) — 매칭이 Master No로 이뤄졌으면
// 배분도 그 번호로 저장해야 매출과 연결된다(매출.blNo와 정확히 같아야 함). 미매칭 줄도 이제
// 버리지 않고 그대로 등록한다(refNo를 blNo로 써서, saleId만 비운 채) — 나중에 그 B/L로 매출이
// 등록되면 createSale의 자동 백필(where: {blNo, saleId:null})이 이 배분을 알아서 연결해준다
// (2026-09-09, "나중에 미매칭이 매칭되게 만들어주는거지?" 요청 — 예전엔 미매칭 줄을 통째로
// 버리고 note에 목록만 적어놨었다).
// amount는 항상 preview.currency 기준 금액이다(외화 명세서면 외화 원금, KRW 명세서면 원화).
type PreviewLine = { refNo: string; masterNo: string | null; amount: number; matched: boolean; matchedBlNo: string | null };
type Preview = {
  data: ExtractedPurchaseStatementSmart;
  lines: PreviewLine[];
  total: number; // preview.currency 기준 전체 합계(미환산) — 매칭 여부와 무관하게 전부 포함.
  partyId: string;
  // 명세서에서 인식된 통화(외화 파트너 명세서는 USD 등, 국내 지출결의서 등은 항상 "KRW").
  // 인식됐어도 사용자가 아래 통화 선택에서 다른 외화로 바꿀 수 있다(2026-09-09).
  currency: string;
};

// 전체 줄을 원화로 환산해 배분한다(매칭 여부 무관). 개별 줄을 각각 반올림하면 합계가 (전체
// 외화합계×환율)을 반올림한 값과 몇 원 어긋날 수 있어(예: 8줄 각각 반올림 오차 누적) —
// createPurchase의 "배분 합계 == 매입 총액" 검증에 걸린다. 그래서 각 줄을 반올림한 뒤 남는
// 차액을 마지막 줄에 몰아 정확히 맞춘다(이미 손익조회 등에서 쓰는 "차액을 한 줄에 몰기"와
// 같은 방식).
function toKrwAllocations(
  lines: { blNo: string; amount: number }[],
  fxRate: number
): { blNo: string; amount: number }[] {
  const rounded = lines.map((l) => Math.round(l.amount * fxRate));
  const exactTotal = Math.round(lines.reduce((sum, l) => sum + l.amount, 0) * fxRate);
  const diff = exactTotal - rounded.reduce((sum, a) => sum + a, 0);
  if (rounded.length > 0) rounded[rounded.length - 1] += diff;
  return lines.map((l, i) => ({ blNo: l.blNo, amount: rounded[i] }));
}

function matchParty(parties: { id: string; name: string }[], name: string) {
  return parties.find((p) => p.name.includes(name) || name.includes(p.name));
}

export type PurchaseStatementQuickUploadHandle = {
  // 부모(VoucherQuickEntry)가 첨부칸 하나로 단건/다건을 모두 받다가, extractPurchaseStatementPdf가
  // 여러 줄을 찾아내면 이걸 호출해 이 컴포넌트의 미리보기 팝업을 연다 — "다건명세서 업로드"라는
  // 별도 버튼 없이도 파일 선택 한 번으로 다건 명세서까지 인식되게 하기 위함(2026-09-09,
  // "파일 선택해서 업로드해도 인식되게 해달라"는 요청).
  openFromExtracted: (data: ExtractedPurchaseStatementSmart) => Promise<void>;
};

// 다건 명세서(House No/Master No별로 여러 화물이 나열된 지출결의서·해외 파트너 명세서 등)의
// 미리보기·등록 팝업. 파일을 직접 받지 않는다 — 부모가 이미 extractPurchaseStatementPdf로
// 추출해둔 결과를 openFromExtracted로 넘겨주면, 전체 줄(매칭 여부 무관)로 매입 총액·배분을
// 만들고 등록 전에 매칭 여부를 미리 확인할 수 있다. 미매칭 줄도 saleId만 비운 채 그대로
// 등록되므로, 나중에 그 B/L로 매출이 등록되면 자동으로 연결된다.
export const PurchaseStatementQuickUpload = forwardRef<
  PurchaseStatementQuickUploadHandle,
  { parties: { id: string; name: string }[]; saleOptions: SaleOption[]; onRegistered: () => void }
>(function PurchaseStatementQuickUpload({ parties, saleOptions, onRegistered }, ref) {
  const [partyList, setPartyList] = useState(parties);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [date, setDate] = useState("");
  const [fxRateDisplay, setFxRateDisplay] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const isForeign = preview ? preview.currency !== "KRW" : false;
  const fxRate = numOf(fxRateDisplay);
  const krwTotal = preview ? (isForeign ? Math.round(preview.total * fxRate) : preview.total) : 0;

  useImperativeHandle(ref, () => ({
    async openFromExtracted(data) {
      setError(null);
      const saleByBlNo = new Map(saleOptions.map((s) => [s.blNo, s]));
      const lines: PreviewLine[] = data.lines.map((l) => {
        // House No(refNo)로 먼저 찾고, 없으면 Master No로도 시도한다 — 매출을 Master No로
        // 등록해둔 경우가 있어서다.
        const matchedBlNo = saleByBlNo.has(l.refNo) ? l.refNo : l.masterNo && saleByBlNo.has(l.masterNo) ? l.masterNo : null;
        return { refNo: l.refNo, masterNo: l.masterNo, amount: l.amount, matched: matchedBlNo !== null, matchedBlNo };
      });
      const total = lines.reduce((sum, l) => sum + l.amount, 0);

      let partyId = partyList[0]?.id ?? "";
      if (data.partyName) {
        const found = matchParty(partyList, data.partyName);
        if (found) {
          partyId = found.id;
        } else {
          const ensured = await ensurePartyByName(data.partyName);
          if (ensured.ok) {
            setPartyList((prev) => (prev.some((p) => p.id === ensured.party.id) ? prev : [...prev, ensured.party]));
            partyId = ensured.party.id;
          }
        }
      }

      setDate(data.period ?? "");
      setFxRateDisplay("");
      setPreview({ data, lines, total, partyId, currency: data.currency ?? "KRW" });
    },
  }));

  function handleRegister() {
    if (!preview) return;
    if (preview.lines.length === 0) {
      setError("등록할 줄이 없습니다.");
      return;
    }
    if (isForeign && (!Number.isFinite(fxRate) || fxRate <= 0)) {
      setError("적용환율을 입력하세요.");
      return;
    }
    const note = preview.data.groupNo ? `Group ${preview.data.groupNo}` : "";

    // 미매칭 줄도 House No(refNo)를 blNo로 그대로 등록한다 — createPurchase가 각 blNo로 매출을
    // 다시 조회해 saleId를 채우므로(매칭되면 그 id, 아니면 null), 여기서 미리 걸러낼 필요가
    // 없다.
    const linesWithBlNo = preview.lines.map((l) => ({ blNo: l.matchedBlNo ?? l.refNo, amount: l.amount }));
    const allocations = isForeign ? toKrwAllocations(linesWithBlNo, fxRate) : linesWithBlNo;
    const fxAmount = linesWithBlNo.reduce((sum, l) => sum + l.amount, 0);

    setError(null);
    startTransition(async () => {
      const result = await createPurchase({
        date,
        partyId: preview.partyId,
        amount: isForeign ? Math.round(fxAmount * fxRate) : preview.total,
        note,
        allocations,
        currency: preview.currency,
        fxAmount: isForeign ? fxAmount : null,
        fxRate: isForeign ? fxRate : null,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setPreview(null);
      onRegistered();
    });
  }

  if (!preview) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="card flex w-full max-w-lg flex-col gap-3 p-5">
        <h3 className="text-sm font-semibold text-fg">
          다건명세서 미리보기 — {partyList.find((p) => p.id === preview.partyId)?.name ?? "거래처 미확인"}
          {preview.data.method === "ai" && <span className="ml-1 text-xs text-muted">(AI로 추출됨)</span>}
        </h3>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted">매입일자</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg"
            />
          </div>
          <div className="flex items-center gap-2">
            {/* 명세서에서 인식된 통화가 기본값이지만(예: USD), 문서와 실제 처리 통화가
                다를 수 있어 여기서 바로 다른 외화로 바꿀 수 있다(2026-09-09 요청). */}
            <label className="text-xs text-muted">통화</label>
            <select
              value={preview.currency}
              onChange={(e) =>
                setPreview((prev) => (prev ? { ...prev, currency: e.target.value } : prev))
              }
              className="rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg"
            >
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          {isForeign && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted">적용환율({preview.currency}당 원화)</label>
              <input
                value={fxRateDisplay}
                onChange={(e) => setFxRateDisplay(commaInput(e.target.value))}
                inputMode="decimal"
                className="num w-24 rounded-md border border-border bg-surface px-2 py-1 text-right text-sm text-fg"
              />
            </div>
          )}
        </div>
        <div className="max-h-64 overflow-y-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-1 pr-3">No</th>
                <th className="py-1 pr-3 text-right">금액{isForeign && ` (${preview.currency})`}</th>
                {isForeign && <th className="py-1 pr-3 text-right">원화 환산</th>}
                <th className="py-1 pr-3">상태</th>
              </tr>
            </thead>
            <tbody>
              {preview.lines.map((l, i) => (
                <tr key={i} className="border-t border-border/60">
                  <td className="py-1 pr-3 text-fg">
                    {l.refNo}
                    {l.masterNo && <div className="text-[11px] text-muted">M/N {l.masterNo}</div>}
                  </td>
                  <td className="py-1 pr-3 text-right num text-fg">{formatAmount(l.amount)}</td>
                  {isForeign && (
                    <td className="py-1 pr-3 text-right num text-muted">
                      {formatAmount(Math.round(l.amount * fxRate))}
                    </td>
                  )}
                  <td className="py-1 pr-3">
                    {l.matched ? (
                      <span className="text-muted">
                        매출 있음{l.matchedBlNo === l.masterNo && "(Master No)"}
                      </span>
                    ) : (
                      <span className="text-warn">미매칭(나중에 자동 연결)</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="text-xs text-muted">
          등록될 매입 총액(전체 {preview.lines.length}줄, 미매칭 포함):{" "}
          <span className="num text-fg">
            {isForeign
              ? `${formatAmount(preview.total)} ${preview.currency} → ${formatAmount(krwTotal)}원`
              : `${formatAmount(preview.total)}원`}
          </span>
        </div>
        {error && <div className="text-sm text-neg">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => setPreview(null)} className="rounded-md px-4 py-1.5 text-sm text-muted hover:text-fg">
            취소
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={handleRegister}
            className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
          >
            {pending ? "등록 중..." : "등록"}
          </button>
        </div>
      </div>
    </div>
  );
});
