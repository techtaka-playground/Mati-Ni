import * as XLSX from "xlsx";
import type { TaxInvoiceDirection, TaxInvoiceRow } from "@/lib/barobill";

export type ParsedTaxInvoiceExcel = {
  direction: TaxInvoiceDirection;
  rows: TaxInvoiceRow[];
};

function toAmount(v: unknown): number {
  return Number(String(v ?? "").replace(/,/g, "")) || 0;
}

function toYmd(v: unknown): string {
  return String(v ?? "").replace(/-/g, "");
}

// 홈택스 "전자(수정) 세금계산서 목록조회" 다운로드(.xls) 전용 파서. 레이아웃이 고정돼 있다:
// 5번째 줄(0-index 4) 첫 칸에 "매출/매입 전자(수정) 세금계산서 목록조회" 제목이 있고,
// 6번째 줄(0-index 5)이 컬럼 헤더, 그다음부터 실제 데이터. 매출표는 "공급받는자"가,
// 매입표는 "공급자"가 우리쪽 거래상대방이라 방향에 따라 읽는 컬럼이 다르다.
export function parseHometaxTaxInvoiceExcel(buffer: Buffer): ParsedTaxInvoiceExcel {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: "buffer" });
  } catch {
    throw new Error("엑셀 파일을 읽지 못했습니다. 홈택스에서 받은 .xls 파일이 맞는지 확인해주세요.");
  }

  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "" });

  const titleRow = rows[4]?.[0] ? String(rows[4][0]) : "";
  if (!titleRow.includes("세금계산서 목록조회")) {
    throw new Error(
      "홈택스 전자(수정) 세금계산서 목록조회 다운로드 파일 형식이 아닌 것 같습니다."
    );
  }
  const direction: TaxInvoiceDirection = titleRow.includes("매입") ? "purchase" : "sales";
  const isSales = direction === "sales";

  const dataRows = rows.slice(6).filter((r) => r[0]); // 작성일자가 있는 실제 데이터 행만

  const result: TaxInvoiceRow[] = dataRows.map((r) => ({
    writeDate: toYmd(r[0]),
    issueDT: toYmd(r[2]),
    ntsSendKey: String(r[1] ?? ""),
    counterpartCorpNum: String((isSales ? r[9] : r[4]) ?? ""),
    counterpartCorpName: String((isSales ? r[11] : r[6]) ?? ""),
    counterpartCEOName: String((isSales ? r[12] : r[7]) ?? ""),
    amountTotal: toAmount(r[15]),
    taxTotal: toAmount(r[16]),
    totalAmount: toAmount(r[14]),
    itemName: String(r[26] ?? ""),
    remark1: String(r[20] ?? ""),
    modifyCode: "0",
    // 홈택스 엑셀 다운로드에는 담당자 이메일 칸이 없다 — API 조회로 받은 건만 채워진다.
    ourStaffEmail: "",
    counterpartEmail: "",
  }));

  if (result.length === 0) {
    throw new Error("이 파일에서 세금계산서 데이터를 찾지 못했습니다.");
  }

  return { direction, rows: result };
}
