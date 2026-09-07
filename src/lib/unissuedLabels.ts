// 세금계산서에 없는(미발행) 금액에 붙일 수 있는 명칭 — 등록 팝업(TaxInvoiceSearchForm의
// 미발행 줄 입력)과 서버 쪽(tax-invoices/actions.ts의 B/L 반영 로직, taxInvoiceAttachments.ts의
// 대표 B/L 판정) 양쪽에서 같은 목록을 써야 한다. "기타"를 고르면 사용자가 직접 입력한다.
export const UNISSUED_LABELS = ["W/F", "부가세", "영세율", "면세", "해외운임", "기타"] as const;
export type UnissuedLabel = (typeof UNISSUED_LABELS)[number];

export function isUnissuedLabel(v: string): boolean {
  return (UNISSUED_LABELS as readonly string[]).includes(v);
}
