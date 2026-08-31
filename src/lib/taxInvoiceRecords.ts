import { prisma } from "@/lib/prisma";
import type { TaxInvoiceDirection, TaxInvoiceRow } from "@/lib/barobill";

function toRow(record: {
  writeDate: string;
  issueDT: string;
  ntsSendKey: string;
  counterpartCorpNum: string;
  counterpartCorpName: string;
  counterpartCEOName: string;
  amountTotal: number;
  taxTotal: number;
  totalAmount: number;
  itemName: string;
  remark1: string;
  modifyCode: string;
}): TaxInvoiceRow {
  return {
    writeDate: record.writeDate,
    issueDT: record.issueDT,
    ntsSendKey: record.ntsSendKey,
    counterpartCorpNum: record.counterpartCorpNum,
    counterpartCorpName: record.counterpartCorpName,
    counterpartCEOName: record.counterpartCEOName,
    amountTotal: record.amountTotal,
    taxTotal: record.taxTotal,
    totalAmount: record.totalAmount,
    itemName: record.itemName,
    remark1: record.remark1,
    modifyCode: record.modifyCode,
    // 저장된 업로드 기록엔 담당자 이메일 칸이 없다(saveTaxInvoiceRecords 참고).
    ourStaffEmail: "",
  };
}

// 엑셀 업로드로 읽은 세금계산서 행을 저장한다. 같은 승인번호로 다시 올리면 덮어쓴다.
export async function saveTaxInvoiceRecords(
  direction: TaxInvoiceDirection,
  rows: TaxInvoiceRow[]
): Promise<void> {
  for (const r of rows) {
    // ourStaffEmail은 TaxInvoiceRecord에 칸이 없다 — 엑셀 업로드본에는 항상 빈 값이라
    // 저장할 이유도 없다(toRow에서 다시 ""로 채워 돌려준다).
    const { ourStaffEmail: _ourStaffEmail, ...record } = r;
    await prisma.taxInvoiceRecord.upsert({
      where: { ntsSendKey: r.ntsSendKey },
      create: { ...record, direction },
      update: { ...record, direction },
    });
  }
}

export async function getSavedTaxInvoiceRecords(
  direction: TaxInvoiceDirection,
  baseMonth: string
): Promise<TaxInvoiceRow[]> {
  const records = await prisma.taxInvoiceRecord.findMany({
    where: { direction, writeDate: { startsWith: baseMonth } },
  });
  return records.map(toRow);
}

// 바로빌 API 결과와 저장된 업로드 내역을 승인번호 기준으로 합친다 — 같은 건이 양쪽에 다
// 있으면 API 쪽(더 최신/신뢰도 높음)을 남긴다. 작성일자 내림차순으로 정렬한다.
export function mergeTaxInvoiceRows(apiRows: TaxInvoiceRow[], savedRows: TaxInvoiceRow[]): TaxInvoiceRow[] {
  const seen = new Set(apiRows.map((r) => r.ntsSendKey));
  const merged = [...apiRows, ...savedRows.filter((r) => !seen.has(r.ntsSendKey))];
  return merged.sort((a, b) => b.writeDate.localeCompare(a.writeDate));
}
