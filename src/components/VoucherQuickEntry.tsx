"use client";

import { useRef, useState, useTransition } from "react";
import { createSale, extractSaleInvoicePdf } from "@/app/(app)/sales/actions";
import { createPurchase, extractPurchaseInvoicePdf } from "@/app/(app)/purchases/actions";
import { ensurePartyByName } from "@/app/(app)/parties/actions";
import { commaInput, numOf } from "@/lib/format";
import { PdfUploadField, type PdfMeta } from "@/components/PdfUploadField";
import { PurchaseStatementQuickUpload } from "@/components/PurchaseStatementQuickUpload";
import { saveUploadedPdf } from "@/lib/fileStorageActions";
import type { ExtractedSaleInvoice, ExtractedPurchaseInvoice } from "@/lib/invoiceExtract";
import { PartySearchSelect, type PartyOption } from "@/components/PartySearchSelect";

type Direction = "sales" | "purchase";
type SaleOption = { id: string; blNo: string; dateStr: string; partyName: string };

// 관세전표(CustomsQuickEntry)와 같은 목록 — 해외 거래처가 외화로 청구하는 경우가 흔해서다.
const CURRENCIES = ["KRW", "USD", "JPY", "EUR", "CNY", "AUD", "HKD", "GBP"] as const;

function matchParty(parties: { id: string; name: string }[], name: string) {
  return parties.find((p) => p.name.includes(name) || name.includes(p.name));
}

// 더존 스타일 한 줄 빠른입력 — 구분(매출/매입)을 고르고 나머지 칸을 채운 뒤 Enter(또는
// 등록 버튼)를 누르면 그 자리에서 바로 등록되고 칸이 비워져 다음 건을 이어서 입력할 수 있다.
// 관세는 여기 없다 — 관세전표("/customs")에서 따로 입력한다. 매입은 항상 B/L 1개 = 전액
// 배분으로 단순화한다 — 여러 B/L로 쪼개야 하는 명세서는 세금계산서 화면의 "묶어서 등록"
// 또는 첨부 기능, 혹은 아래 다건명세서 업로드를 쓴다.
//
// 관세전표의 "수기기입"과 같은 방식으로 버튼 → 팝업으로 연다(2026-08-27) — 목록 화면이
// 입력 폼으로 늘 붐비지 않게. 연속 등록(Enter)을 위해 등록에 성공해도 팝업은 자동으로
// 닫지 않고 필드만 비운다.
export function VoucherQuickEntry({
  parties,
  saleOptions,
}: {
  parties: PartyOption[];
  saleOptions: SaleOption[];
}) {
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<Direction>("sales");
  const [partyList, setPartyList] = useState(parties);
  const [blNo, setBlNo] = useState("");
  const [date, setDate] = useState("");
  // 관세전표(CustomsQuickEntry)와 같은 검색형 선택(PartySearchSelect)으로 바꾸면서(2026-09-03)
  // "첫 거래처가 기본 선택됨"이 사라졌다 — 거래처가 수십~수백 건이면 첫 거래처가 무엇인지도
  // 모르고 그대로 등록되는 사고가 더 위험하다고 판단해, 직접 검색해서 고르게 한다.
  const [partyId, setPartyId] = useState<string | null>(null);
  const [amountDisplay, setAmountDisplay] = useState("");
  const [currency, setCurrency] = useState<string>("KRW");
  const [fxAmountDisplay, setFxAmountDisplay] = useState("");
  const [fxRateDisplay, setFxRateDisplay] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [partyHint, setPartyHint] = useState<string | null>(null);
  const [savedFile, setSavedFile] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const dateRef = useRef<HTMLInputElement>(null);

  const amount = numOf(amountDisplay);
  const fxAmount = numOf(fxAmountDisplay);
  const fxRate = numOf(fxRateDisplay);
  const isForeign = currency !== "KRW";
  // 외화일 때 화면에 바로 보여주는 원화 환산 미리보기 — 실제 저장액은 서버가 다시 계산한다
  // (createSale/createPurchase 주석 참고), 이건 입력 확인용일 뿐이다.
  const krwPreview = isForeign ? Math.round(fxAmount * fxRate) : amount;
  const match = direction === "purchase" ? saleOptions.find((s) => s.blNo === blNo.trim()) : undefined;

  function resetLine() {
    setBlNo("");
    setAmountDisplay("");
    setCurrency("KRW");
    setFxAmountDisplay("");
    setFxRateDisplay("");
    setNote("");
    setError(null);
    setPartyHint(null);
    setSavedFile(null);
    dateRef.current?.focus();
  }

  async function applyExtractedSale(d: ExtractedSaleInvoice, meta: PdfMeta) {
    if (d.blNo) setBlNo(d.blNo);
    if (d.date) setDate(d.date);
    if (d.amount != null) setAmountDisplay(commaInput(String(d.amount)));
    if (d.note) setNote(d.note);
    await applyPartyHint(d.partyName, meta, d.amount, d.date);
  }

  async function applyExtractedPurchase(d: ExtractedPurchaseInvoice, meta: PdfMeta) {
    if (d.date) setDate(d.date);
    if (d.amount != null) setAmountDisplay(commaInput(String(d.amount)));
    if (d.note) setNote(d.note);
    await applyPartyHint(d.partyName, meta, d.amount, d.date);
  }

  async function applyPartyHint(
    partyName: string | null,
    meta: PdfMeta,
    extractedAmount: number | null,
    extractedDate: string | null
  ) {
    if (partyName) {
      const found = matchParty(partyList, partyName);
      if (found) {
        setPartyId(found.id);
        setPartyHint(null);
      } else {
        const result = await ensurePartyByName(partyName);
        if (result.ok) {
          // ensurePartyByName은 code를 안 돌려준다(이 경로로 새로 생기는 거래처는 아직 코드가
          // 없다 — PartySearchSelect 표시용으로 null을 채워둔다).
          setPartyList((prev) =>
            prev.some((p) => p.id === result.party.id) ? prev : [...prev, { ...result.party, code: null }]
          );
          setPartyId(result.party.id);
          setPartyHint(
            result.created ? `거래처 "${result.party.name}"를 자동 등록했습니다.` : `기존 거래처 "${result.party.name}"를 사용합니다.`
          );
        }
      }
    }
    setSavedFile(null);
    const saved = await saveUploadedPdf({
      base64: meta.base64,
      originalName: meta.filename,
      party: partyName,
      amount: extractedAmount ?? 0,
      period: extractedDate,
    });
    if (saved.ok) setSavedFile(saved.filename);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!date || !blNo.trim() || !partyId) {
      setError("필수 항목을 모두 입력하세요.");
      return;
    }
    if (isForeign ? fxAmount === 0 || fxRate === 0 : !Number.isFinite(amount) || amount === 0) {
      setError(isForeign ? "외화 금액과 적용 환율을 입력하세요." : "필수 항목을 모두 입력하세요.");
      return;
    }
    const resolvedPartyId = partyId;

    startTransition(async () => {
      if (direction === "sales") {
        const result = await createSale({
          blNo,
          date,
          partyId: resolvedPartyId,
          amount: krwPreview,
          note,
          currency,
          fxAmount: isForeign ? fxAmount : null,
          fxRate: isForeign ? fxRate : null,
        });
        if (!result.ok) { setError(result.message); return; }
        resetLine();
      } else {
        const result = await createPurchase({
          date,
          partyId: resolvedPartyId,
          amount: krwPreview,
          note,
          allocations: [{ blNo, amount: krwPreview }],
          currency,
          fxAmount: isForeign ? fxAmount : null,
          fxRate: isForeign ? fxRate : null,
        });
        if (!result.ok) { setError(result.message); return; }
        resetLine();
      }
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
            <h3 className="text-xl font-semibold text-fg">일반전표 수기기입</h3>

            <form onSubmit={handleSubmit} className="flex flex-col gap-5">
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-muted">구분</span>
                  <select
                    value={direction}
                    onChange={(e) => {
                      setDirection(e.target.value as Direction);
                      resetLine();
                    }}
                    className="w-56 rounded-xl border border-border bg-surface px-3 py-2 text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
                  >
                    <option value="sales">매출</option>
                    <option value="purchase">매입</option>
                  </select>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-muted">작성일자</span>
                  <input
                    ref={dateRef}
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="w-56 rounded-xl border border-border bg-surface px-3 py-2 text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-muted">거래처</span>
                  <PartySearchSelect
                    parties={partyList}
                    value={partyId}
                    onChange={setPartyId}
                    placeholder="코드/거래처명"
                    className="w-56"
                  />
                </div>
                <div className="flex items-start justify-between gap-3">
                  <span className="pt-2 text-sm text-muted">B/L</span>
                  <div className="flex w-56 flex-col items-end gap-1">
                    <input
                      value={blNo}
                      onChange={(e) => setBlNo(e.target.value)}
                      list="voucher-bl-options"
                      placeholder="B/L 번호"
                      className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
                    />
                    {direction === "purchase" && blNo.trim() && (
                      <span className={`text-xs ${match ? "text-muted" : "text-neg"}`}>
                        {match
                          ? `매출 있음 (${match.partyName} · ${match.dateStr})`
                          : "아직 등록된 매출 없음 — 나중에 자동 연결됨"}
                      </span>
                    )}
                  </div>
                </div>
                <datalist id="voucher-bl-options">
                  {saleOptions.map((s) => (
                    <option key={s.id} value={s.blNo}>
                      {s.partyName} · {s.dateStr}
                    </option>
                  ))}
                </datalist>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-muted">통화</span>
                  <select
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                    className="w-56 rounded-xl border border-border bg-surface px-3 py-2 text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
                  >
                    {CURRENCIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                {isForeign ? (
                  <>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm text-muted">외화금액 ({currency})</span>
                      <input
                        value={fxAmountDisplay}
                        onChange={(e) => setFxAmountDisplay(commaInput(e.target.value))}
                        inputMode="decimal"
                        className="num w-56 rounded-xl border border-border bg-surface px-3 py-2 text-right text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
                      />
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm text-muted">적용환율 ({currency}당 원화)</span>
                      <input
                        value={fxRateDisplay}
                        onChange={(e) => setFxRateDisplay(commaInput(e.target.value))}
                        inputMode="decimal"
                        className="num w-56 rounded-xl border border-border bg-surface px-3 py-2 text-right text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
                      />
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm text-muted">원화 환산액</span>
                      <span className="num w-56 text-right text-base font-medium text-fg">
                        {krwPreview.toLocaleString("ko-KR")}원
                      </span>
                    </div>
                  </>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-muted">금액</span>
                    <input
                      value={amountDisplay}
                      onChange={(e) => setAmountDisplay(commaInput(e.target.value))}
                      inputMode="decimal"
                      className="num w-56 rounded-xl border border-border bg-surface px-3 py-2 text-right text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
                    />
                  </div>
                )}
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-muted">비고</span>
                  <input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    className="w-56 rounded-xl border border-border bg-surface px-3 py-2 text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <span className="text-sm text-muted">인보이스 첨부</span>
                  <div className="flex flex-wrap items-center gap-2">
                    {direction === "sales" && (
                      <PdfUploadField extractAction={extractSaleInvoicePdf} onExtracted={applyExtractedSale} label="" />
                    )}
                    {direction === "purchase" && (
                      <PdfUploadField
                        extractAction={extractPurchaseInvoicePdf}
                        onExtracted={applyExtractedPurchase}
                        label=""
                      />
                    )}
                    {direction === "purchase" && (
                      <PurchaseStatementQuickUpload parties={partyList} saleOptions={saleOptions} onRegistered={() => {}} />
                    )}
                  </div>
                </div>
              </div>

              {partyHint && <div className="text-sm text-muted">{partyHint}</div>}
              {savedFile && <div className="text-sm text-muted">원본 저장됨: uploads/{savedFile}</div>}
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
