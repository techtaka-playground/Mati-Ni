"use client";

import { useRef, useState, useTransition } from "react";
import { createCustomsAdvance, extractCustomsInvoicePdf } from "@/app/(app)/customs/actions";
import { commaInput, numOf } from "@/lib/format";
import { PdfUploadField, type PdfMeta } from "@/components/PdfUploadField";
import { saveUploadedPdf } from "@/lib/fileStorageActions";
import type { ExtractedCustomsInvoice } from "@/lib/invoiceExtract";
import { PartySearchSelect, type PartyOption } from "@/components/PartySearchSelect";

type SaleOption = { id: string; blNo: string; dateStr: string; partyName: string };

// 관세전표 한 줄 빠른입력 — 일반전표(VoucherQuickEntry)와 같은 방식이다. 거래처는 **선택**이고
// 거래처 마스터에 이미 있는 것만 코드/이름으로 검색해서 고른다(PartySearchSelect). 비워두면
// blNo로 나중에 매출이 연결될 때 그 매출의 거래처가 보인다.
//
// 예전엔 목록 위에 항상 펼쳐져 있었는데, "수기기입" 버튼 → 팝업으로 바꿨다(2026-08-27) —
// 목록 화면이 입력 폼으로 늘 붐비는 게 아니라 필요할 때만 열리게. 연속 등록(Enter)을 위해
// 등록에 성공해도 팝업은 자동으로 닫지 않고 필드만 비운다 — 여러 건을 잇달아 입력하는
// 흐름을 그대로 유지한다.
export function CustomsQuickEntry({
  saleOptions,
  parties,
}: {
  saleOptions: SaleOption[];
  parties: PartyOption[];
}) {
  const [open, setOpen] = useState(false);
  const [blNo, setBlNo] = useState("");
  const [paidDate, setPaidDate] = useState("");
  const [amountDisplay, setAmountDisplay] = useState("");
  const [note, setNote] = useState("");
  const [partyId, setPartyId] = useState<string | null>(null);
  const [payeePartyId, setPayeePartyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedFile, setSavedFile] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const dateRef = useRef<HTMLInputElement>(null);

  const amount = numOf(amountDisplay);
  const match = saleOptions.find((s) => s.blNo === blNo.trim());

  function resetLine() {
    setBlNo("");
    setAmountDisplay("");
    setNote("");
    setError(null);
    setSavedFile(null);
    dateRef.current?.focus();
  }

  async function applyExtracted(d: ExtractedCustomsInvoice, meta: PdfMeta) {
    if (d.blNo) setBlNo(d.blNo);
    if (d.paidDate) setPaidDate(d.paidDate);
    if (d.amount != null) setAmountDisplay(commaInput(String(d.amount)));
    if (d.note) setNote(d.note);
    setSavedFile(null);
    const matched = d.blNo ? saleOptions.find((s) => s.blNo === d.blNo) : undefined;
    const saved = await saveUploadedPdf({
      base64: meta.base64,
      originalName: meta.filename,
      party: matched?.partyName ?? null,
      amount: d.amount ?? 0,
      period: d.paidDate,
    });
    if (saved.ok) setSavedFile(saved.filename);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!paidDate || !blNo.trim() || !Number.isFinite(amount) || amount === 0) {
      setError("필수 항목을 모두 입력하세요.");
      return;
    }
    startTransition(async () => {
      const result = await createCustomsAdvance({ blNo, paidDate, amount, note, partyId, payeePartyId });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      resetLine();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-border bg-surface px-4 py-1.5 text-sm text-fg hover:bg-gray-95"
      >
        수기기입
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="card flex w-full max-w-2xl flex-col gap-5 p-8">
            <h3 className="text-xl font-semibold text-fg">관세전표 수기기입</h3>

            <form onSubmit={handleSubmit} className="flex flex-col gap-5">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm text-muted">인보이스 첨부</label>
                <PdfUploadField extractAction={extractCustomsInvoicePdf} onExtracted={applyExtracted} label="" />
                {savedFile && <span className="text-sm text-muted">원본 저장됨: uploads/{savedFile}</span>}
              </div>

              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-muted">청구일</span>
                  <input
                    ref={dateRef}
                    type="date"
                    value={paidDate}
                    onChange={(e) => setPaidDate(e.target.value)}
                    className="w-56 rounded-xl border border-border bg-surface px-3 py-2 text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
                  />
                </div>
                <div className="flex items-start justify-between gap-3">
                  <span className="pt-2 text-sm text-muted">B/L</span>
                  <div className="flex w-56 flex-col items-end gap-1">
                    <input
                      value={blNo}
                      onChange={(e) => setBlNo(e.target.value)}
                      list="customs-quick-bl-options"
                      placeholder="B/L 번호"
                      className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
                    />
                    {blNo.trim() && (
                      <span className={`text-xs ${match ? "text-muted" : "text-neg"}`}>
                        {match
                          ? `매출 있음 (${match.partyName} · ${match.dateStr})`
                          : "아직 등록된 매출 없음 — 나중에 자동 연결됨"}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-muted">거래처 (선택, 회수 대상)</span>
                  <PartySearchSelect
                    parties={parties}
                    value={partyId}
                    onChange={setPartyId}
                    placeholder="코드/거래처명"
                    className="w-56"
                  />
                </div>
                {/* 거래처(위)는 나중에 관세대납금을 **회수할 고객사**, 지급처(여기)는 지금 **돈을
                    지급받는 관세사·포워더** — 서로 다른 회사다(출금 매칭이 이 값을 쓴다,
                    bankAllocation.ts 참고). 비워두면 출금 매칭도 거래처 값으로 대신 찾아본다. */}
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-muted">지급처 (선택, 실제 지급 대상)</span>
                  <PartySearchSelect
                    parties={parties}
                    value={payeePartyId}
                    onChange={setPayeePartyId}
                    placeholder="코드/거래처명"
                    className="w-56"
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-muted">청구액</span>
                  <input
                    value={amountDisplay}
                    onChange={(e) => setAmountDisplay(commaInput(e.target.value))}
                    inputMode="decimal"
                    className="num w-56 rounded-xl border border-border bg-surface px-3 py-2 text-right text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-muted">비고</span>
                  <input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    className="w-56 rounded-xl border border-border bg-surface px-3 py-2 text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
                  />
                </div>
              </div>
              <datalist id="customs-quick-bl-options">
                {saleOptions.map((s) => (
                  <option key={s.id} value={s.blNo}>
                    {s.partyName} · {s.dateStr}
                  </option>
                ))}
              </datalist>

              {error && <div className="text-base text-neg">{error}</div>}

              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-xl px-5 py-2.5 text-base text-muted hover:text-fg"
                >
                  취소
                </button>
                <button
                  type="submit"
                  disabled={pending}
                  className="rounded-xl bg-accent px-6 py-2.5 text-base font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
                >
                  {pending ? "등록 중..." : "등록 (Enter)"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
