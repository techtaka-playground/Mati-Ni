// 탭별 열람 권한 필드 정의 — 서버 액션(users/actions.ts)과 클라이언트 컴포넌트(초대 폼·
// 계정 표) 양쪽에서 공유한다. "use server" 파일은 함수 외의 값을 export할 수 없어서
// 별도 파일로 뺐다(2026-08-27).
export const PERMISSION_FIELDS = [
  "canViewPnl",
  "canViewVouchers",
  "canViewCustoms",
  "canViewTaxInvoices",
  "canViewBankLogs",
  "canViewParties",
] as const;
export type PermissionField = (typeof PERMISSION_FIELDS)[number];

export const PERMISSION_LABELS: Record<PermissionField, string> = {
  canViewPnl: "손익조회",
  canViewVouchers: "일반전표",
  canViewCustoms: "관세전표",
  canViewTaxInvoices: "세금계산서",
  canViewBankLogs: "입출금내역",
  canViewParties: "거래처",
};
