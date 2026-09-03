"use client";

import { useState, useTransition } from "react";
import { extractPurchaseStatementPdf, createPurchase } from "@/app/(app)/purchases/actions";
import { ensurePartyByName } from "@/app/(app)/parties/actions";
import { fileToBase64 } from "@/lib/clientFile";
import { formatAmount } from "@/lib/format";
import type { ExtractedPurchaseStatementSmart } from "@/app/(app)/purchases/actions";

type SaleOption = { id: string; blNo: string; dateStr: string; partyName: string };

// matchedBlNo: 실제로 매출과 일치한 번호(House 또는 Master) — 매칭이 Master No로 이뤄졌으면
// 배분도 그 번호로 저장해야 매출과 연결된다(매출.blNo와 정확히 같아야 함).
type PreviewLine = { refNo: string; masterNo: string | null; amount: number; matched: boolean; matchedBlNo: string | null };
type Preview = {
  data: ExtractedPurchaseStatementSmart;
  lines: PreviewLine[];
  matchedTotal: number;
  partyId: string;
};

function matchParty(parties: { id: string; name: string }[], name: string) {
  return parties.find((p) => p.name.includes(name) || name.includes(p.name));
}

// 다건 명세서(House No/Master No별로 여러 화물이 나열된 지출결의서 등) 업로드 — 전표
// 빠른입력의 "매입" 구분 옆에 작은 보조 버튼으로 붙는다. 정확히 일치하는 기존 매출(B/L)의
// 줄만 골라 매입 총액·배분을 자동으로 만들고, 등록 전에 매칭 여부를 미리 확인할 수 있다.
export function PurchaseStatementQuickUpload({
  parties,
  saleOptions,
  onRegistered,
}: {
  parties: { id: string; name: string }[];
  saleOptions: SaleOption[];
  onRegistered: () => void;
}) {
  const [partyList, setPartyList] = useState(parties);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [date, setDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, startTransition] = useTransition();

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    setLoading(true);
    try {
      const base64 = await fileToBase64(file);
      const result = await extractPurchaseStatementPdf(base64);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      const data = result.data;
      const saleByBlNo = new Map(saleOptions.map((s) => [s.blNo, s]));
      const lines: PreviewLine[] = data.lines.map((l) => {
        // House No(refNo)로 먼저 찾고, 없으면 Master No로도 시도한다 — 매출을 Master No로
        // 등록해둔 경우가 있어서다.
        const matchedBlNo = saleByBlNo.has(l.refNo) ? l.refNo : l.masterNo && saleByBlNo.has(l.masterNo) ? l.masterNo : null;
        return { refNo: l.refNo, masterNo: l.masterNo, amount: l.amount, matched: matchedBlNo !== null, matchedBlNo };
      });
      const matchedTotal = lines.filter((l) => l.matched).reduce((sum, l) => sum + l.amount, 0);

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
      setPreview({ data, lines, matchedTotal, partyId });
    } catch {
      setError("PDF 처리 중 오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  }

  function handleRegister() {
    if (!preview) return;
    const matchedLines = preview.lines.filter((l) => l.matched);
    if (matchedLines.length === 0) {
      setError("기존 매출과 일치하는 줄이 없습니다.");
      return;
    }
    const unmatched = preview.lines.filter((l) => !l.matched).map((l) => l.refNo);
    const note = [preview.data.groupNo ? `Group ${preview.data.groupNo}` : null, unmatched.length > 0 ? `미매칭: ${unmatched.join(", ")}` : null]
      .filter(Boolean)
      .join(" / ");

    setError(null);
    startTransition(async () => {
      const result = await createPurchase({
        date,
        partyId: preview.partyId,
        amount: preview.matchedTotal,
        note,
        allocations: matchedLines.map((l) => ({ blNo: l.matchedBlNo!, amount: l.amount })),
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setPreview(null);
      onRegistered();
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="cursor-pointer text-xs text-accent hover:underline">
        {loading ? "분석 중..." : "다건명세서 업로드"}
        <input type="file" accept="application/pdf" onChange={handleFile} disabled={loading} className="hidden" />
      </label>
      {error && <div className="text-xs text-neg">{error}</div>}

      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="card flex w-full max-w-lg flex-col gap-3 p-5">
            <h3 className="text-sm font-semibold text-fg">
              다건명세서 미리보기 — {partyList.find((p) => p.id === preview.partyId)?.name ?? "거래처 미확인"}
              {preview.data.method === "ai" && <span className="ml-1 text-xs text-muted">(AI로 추출됨)</span>}
            </h3>
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted">매입일자</label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg"
              />
            </div>
            <div className="max-h-64 overflow-y-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted">
                    <th className="py-1 pr-3">No</th>
                    <th className="py-1 pr-3 text-right">금액</th>
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
                      <td className="py-1 pr-3">
                        {l.matched ? (
                          <span className="text-muted">
                            매출 있음{l.matchedBlNo === l.masterNo && "(Master No)"}
                          </span>
                        ) : (
                          <span className="text-neg">미매칭(제외)</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="text-xs text-muted">
              등록될 매입 총액(매칭된 줄만): <span className="num text-fg">{formatAmount(preview.matchedTotal)}</span>
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
      )}
    </div>
  );
}
