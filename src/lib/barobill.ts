import * as soap from "soap";

const TEST_WSDL = "https://testws.baroservice.com/TI.asmx?wsdl";
const PROD_WSDL = "https://ws.baroservice.com/TI.asmx?wsdl";

// 페이지당 최대 100건 — 안전장치로 최대 이만큼 페이지까지만 자동 취합한다(최대 2000건).
const MAX_PAGES = 20;

export type TaxInvoiceDirection = "sales" | "purchase";

export type TaxInvoiceRow = {
  writeDate: string; // YYYYMMDD
  issueDT: string; // YYYYMMDDHHMMSS
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
  // 이 세금계산서에 적힌 "우리 쪽" 담당자 이메일 — 매출이면 공급자(Invoicer, 우리)의
  // InvoicerEmail, 매입이면 공급받는자(Invoicee, 우리)의 InvoiceeEmail. 응답에 이미 들어있는
  // 값인데 지금까지 읽지 않고 버리고 있었다(2026-08-31, sol-mate가 같은 API 응답에서
  // 이 필드를 쓰는 걸 보고 확인함). 거래처 담당자 이메일(열람권한)을 자동으로 채우는 데 쓴다.
  ourStaffEmail: string;
};

let clientPromise: Promise<soap.Client> | null = null;

function getWsdlUrl(): string {
  return process.env.BAROBILL_ENV === "production" ? PROD_WSDL : TEST_WSDL;
}

function getClient(): Promise<soap.Client> {
  if (!clientPromise) {
    clientPromise = soap.createClientAsync(getWsdlUrl()).catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

function getCredentials() {
  const CERTKEY = process.env.BAROBILL_CERTKEY;
  const CorpNum = process.env.BAROBILL_CORPNUM;
  const UserID = process.env.BAROBILL_USERID;
  if (!CERTKEY || !CorpNum || !UserID) {
    throw new Error(
      "바로빌 연동 정보가 설정되지 않았습니다. .env에 BAROBILL_CERTKEY, BAROBILL_CORPNUM, BAROBILL_USERID를 설정하세요."
    );
  }
  return { CERTKEY, CorpNum, UserID };
}

// .NET SOAP 배열은 원소가 1개면 객체, 0개면 undefined, 여러 개면 배열로 온다 — 항상 배열로 맞춘다.
function normalizeList(x: unknown): Record<string, unknown>[] {
  if (!x) return [];
  return Array.isArray(x) ? (x as Record<string, unknown>[]) : [x as Record<string, unknown>];
}

// API가 주는 NTSSendKey는 대시 없이 24자리(작성일자8+발급코드8+일련번호8)로 온다. 홈택스
// 엑셀 업로드본(parseHometaxTaxInvoiceExcel)과 이 앱에 저장되는 모든 값(TaxInvoiceAttachment,
// Sale/Purchase.ntsSendKey 등)은 전부 "YYYYMMDD-XXXXXXXX-XXXXXXXX" 대시 포함 형식이라, API
// 결과도 반드시 이 형식으로 맞춰야 한다 — 안 그러면 같은 세금계산서가 API 결과와 엑셀
// 업로드본에서 서로 다른 문자열로 보여 mergeTaxInvoiceRows의 승인번호 중복 제거가 실패하고
// 목록에 같은 건이 두 번 나온다(실제로 겪은 버그).
function formatNtsSendKey(raw: string): string {
  if (raw.length !== 24 || raw.includes("-")) return raw;
  return `${raw.slice(0, 8)}-${raw.slice(8, 16)}-${raw.slice(16)}`;
}

function toRow(raw: Record<string, unknown>, direction: TaxInvoiceDirection): TaxInvoiceRow {
  const s = (v: unknown) => (v == null ? "" : String(v));
  const n = (v: unknown) => Number(v ?? 0) || 0;
  return {
    writeDate: s(raw.WriteDate),
    issueDT: s(raw.IssueDT),
    ntsSendKey: formatNtsSendKey(s(raw.NTSSendKey)),
    counterpartCorpNum: s(raw.CorpNum),
    counterpartCorpName: s(raw.CorpName),
    counterpartCEOName: s(raw.CEOName),
    amountTotal: n(raw.AmountTotal),
    taxTotal: n(raw.TaxTotal),
    totalAmount: n(raw.TotalAmount),
    itemName: s(raw.ItemName),
    remark1: s(raw.Remark1),
    modifyCode: s(raw.ModifyCode),
    // 매출은 우리가 공급자(Invoicer), 매입은 우리가 공급받는자(Invoicee)다.
    ourStaffEmail: direction === "sales" ? s(raw.InvoicerEmail) : s(raw.InvoiceeEmail),
  };
}

export async function getMonthlyTaxInvoices({
  direction,
  baseMonth, // "YYYYMM"
  taxType = 1, // 1: 과세+영세, 3: 면세
  dateType = 1, // 1: 작성일자, 2: 발급일자, 3: 전송일자
}: {
  direction: TaxInvoiceDirection;
  baseMonth: string;
  taxType?: number;
  dateType?: number;
}): Promise<{ rows: TaxInvoiceRow[]; truncated: boolean }> {
  const client = await getClient();
  const { CERTKEY, CorpNum, UserID } = getCredentials();

  const method =
    direction === "sales" ? "GetMonthlyTaxInvoiceSalesListExAsync" : "GetMonthlyTaxInvoicePurchaseListExAsync";
  const resultKey =
    direction === "sales" ? "GetMonthlyTaxInvoiceSalesListExResult" : "GetMonthlyTaxInvoicePurchaseListExResult";

  const call = (client as unknown as Record<string, (args: unknown) => Promise<unknown[]>>)[method];

  const rows: TaxInvoiceRow[] = [];
  let currentPage = 1;
  let maxPageNum = 1;
  let truncated = false;

  do {
    const [result] = (await call({
      CERTKEY,
      CorpNum,
      UserID,
      TaxType: taxType,
      DateType: dateType,
      BaseMonth: baseMonth,
      CountPerPage: 100,
      CurrentPage: currentPage,
      OrderDirection: 1,
    })) as [Record<string, Record<string, unknown>>];

    const payload = result[resultKey];
    if (!payload) break;

    const pageNum = Number(payload.CurrentPage ?? 0);
    if (pageNum < 0) {
      throw new Error(`바로빌 조회 실패 (오류코드 ${pageNum})`);
    }

    maxPageNum = Number(payload.MaxPageNum ?? 1);
    const listWrapper = payload.SimpleTaxInvoiceEx2List as Record<string, unknown> | undefined;
    rows.push(...normalizeList(listWrapper?.SimpleTaxInvoiceEx2).map((r) => toRow(r, direction)));

    currentPage++;
    if (currentPage > MAX_PAGES && currentPage <= maxPageNum) {
      truncated = true;
      break;
    }
  } while (currentPage <= maxPageNum);

  return { rows, truncated };
}

// 목록에 있는 NTSSendKey(국세청 승인번호)로 세금계산서 원문을 볼 수 있는 URL을 받는다.
// 반환된 URL은 60초만 유효하므로 받는 즉시 열어야 한다. ID는 필요하지만 PWD는 실제
// WSDL에서 이미 제거된 상태(문서엔 남아있지만 "더 이상 사용 안 함")라 파라미터에 없다.
//
// 주의: 이 API의 NTSConfirmNum은 대시 없는 24자리 원본 형식을 받는다 — toRow()에서
// 만든 대시 포함 ntsSendKey(이 앱 전체에서 쓰는 표준 형식)를 그대로 넘기면 오류코드
// -21002로 실패한다. 그래서 여기서만 대시를 다시 벗겨서 보낸다.
export async function getTaxInvoicePrintUrl(ntsSendKey: string): Promise<string> {
  const client = await getClient();
  const { CERTKEY, CorpNum, UserID } = getCredentials();

  const call = (client as unknown as Record<string, (args: unknown) => Promise<unknown[]>>)
    .GetTaxInvoicePrintURLNKAsync;

  const [result] = (await call({
    CERTKEY,
    CorpNum,
    NTSConfirmNum: ntsSendKey.replace(/-/g, ""),
    ID: UserID,
  })) as [Record<string, unknown>];

  const url = String(result.GetTaxInvoicePrintURLNKResult ?? "");
  if (!url || Number(url) < 0) {
    throw new Error(`세금계산서 원문 URL을 가져오지 못했습니다 (오류코드 ${url || "unknown"})`);
  }
  return url;
}
