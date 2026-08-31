import * as soap from "soap";

// 계좌 입출금내역 서비스는 세금계산서(TI.asmx)와 다른 WSDL이다.
const TEST_WSDL = "https://testws.baroservice.com/BANKACCOUNT.asmx?wsdl";
const PROD_WSDL = "https://ws.baroservice.com/BANKACCOUNT.asmx?wsdl";

// 페이지당 최대 건수 — TI와 같은 이유로 안전장치를 둔다(최대 2000건).
const MAX_PAGES = 20;
const COUNT_PER_PAGE = 100;

export type BankAccount = {
  bankCode: string;
  bankName: string;
  accountNum: string;
  accountType: string; // "1" 법인 / "0" 개인 등 (바로빌 코드)
  alias: string; // 사용자가 바로빌에 등록할 때 지정한 별칭
  collectCycle: string; // 수집주기
  usage: string;
};

export type BankLogRow = {
  accountNum: string;
  transDT: string; // YYYYMMDDHHMMSS (바로빌 응답 원본)
  deposit: number; // 입금액
  withdraw: number; // 출금액
  balance: number; // 거래 후 잔액
  transType: string; // 거래구분(은행 제공 문자열)
  transOffice: string; // 거래점/상대처
  transRemark: string; // 적요
  // 거래 1건을 고유하게 가리키는 바로빌 키. 목록 응답에 실제로 들어있다(처음엔 Ex 타입에만
  // 있다고 잘못 적어뒀다) — 화면 key로 쓰고, 나중에 전표와 대조할 때의 식별자로도 쓸 수 있다.
  transRefKey: string;
  mgtRemark1: string; // 바로빌 관리메모1
  mgtRemark2: string;
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

// 세금계산서와 같은 자격정보를 쓴다(같은 바로빌 계정의 다른 서비스).
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

// .NET SOAP 배열은 원소가 1개면 객체, 0개면 undefined, 여러 개면 배열로 온다 — TI와 동일.
function normalizeList(x: unknown): Record<string, unknown>[] {
  if (!x) return [];
  return Array.isArray(x) ? (x as Record<string, unknown>[]) : [x as Record<string, unknown>];
}

const s = (v: unknown) => (v == null ? "" : String(v));
// 금액 필드가 string으로 오고(WSDL상 Withdraw/Deposit/Balance 전부 string) 천단위 콤마가
// 섞여 있을 수 있어, 숫자 이외 문자를 걷어내고 변환한다.
const n = (v: unknown) => {
  const num = Number(s(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(num) ? num : 0;
};

// 바로빌은 실패를 예외가 아니라 음수 코드로 돌려준다(TI와 같은 방식) — 호출부에서 알아볼 수
// 있게 메시지에 코드를 실어 던진다.
function throwIfErrorCode(value: number, what: string): void {
  if (value < 0) throw new Error(`바로빌 ${what} 실패 (오류코드 ${value})`);
}

// 바로빌에 등록해둔 계좌 목록. availOnly=1이면 현재 사용 가능한 계좌만.
export async function getBankAccounts(availOnly = true): Promise<BankAccount[]> {
  const client = await getClient();
  const { CERTKEY, CorpNum } = getCredentials();

  // **Ex2를 쓴다.** GetBankAccountEx는 은행명·계좌번호만 주는데, Ex2는 별칭(Alias)·용도(Usage)·
  // 수집주기·은행코드까지 준다. 계좌가 2개 이상이면 번호만으로는 어느 계좌인지 알 수 없어서
  // (실제로 "포워더매출"·"관세대납" 두 계좌가 있다) 별칭이 있어야 셀렉트에서 구분이 된다.
  const call = (client as unknown as Record<string, (args: unknown) => Promise<unknown[]>>)
    .GetBankAccountEx2Async;
  const [result] = (await call({ CERTKEY, CorpNum, AvailOnly: availOnly ? 1 : 0 })) as [
    Record<string, unknown>,
  ];

  const payload = result.GetBankAccountEx2Result as Record<string, unknown> | undefined;
  // 계좌가 없거나 오류면 배열 대신 음수 코드가 문자열로 올 수 있다.
  if (payload == null) return [];
  if (typeof payload !== "object") {
    throwIfErrorCode(Number(payload), "계좌 목록 조회");
    return [];
  }

  // 응답 요소명이 WSDL 타입명과 다를 수 있다 — Ex2는 `BankAccountEx`, Ex는 `BankAccount`로
  // 온다(규칙이 일관되지 않다). 예전에 이 키를 잘못 짚어서, 계좌가 등록돼 있는데도 화면에
  // "등록된 계좌가 없습니다"만 뜨는 버그가 있었다. 그래서 알려진 키를 모두 확인한다.
  const accountList = payload.BankAccountEx ?? payload.BankAccount ?? payload.BankAccountEx2;
  return normalizeList(accountList).map((raw) => ({
    bankCode: s(raw.BankCode),
    bankName: s(raw.BankName),
    accountNum: s(raw.BankAccountNum),
    accountType: s(raw.BankAccountType),
    alias: s(raw.Alias),
    collectCycle: s(raw.CollectCycle),
    usage: s(raw.Usage),
  }));
}

// 기간별 입출금내역. StartDate/EndDate는 "YYYYMMDD".
export async function getPeriodBankAccountLog({
  accountNum,
  startDate,
  endDate,
  orderDirection = 1, // 1: 오름차순, 2: 내림차순
}: {
  accountNum: string;
  startDate: string;
  endDate: string;
  orderDirection?: number;
}): Promise<{ rows: BankLogRow[]; truncated: boolean }> {
  const client = await getClient();
  const { CERTKEY, CorpNum, UserID } = getCredentials();

  const call = (client as unknown as Record<string, (args: unknown) => Promise<unknown[]>>)
    .GetPeriodBankAccountLogExAsync;

  const rows: BankLogRow[] = [];
  let currentPage = 1;
  let maxPageNum = 1;
  let truncated = false;

  do {
    const [result] = (await call({
      CERTKEY,
      CorpNum,
      ID: UserID,
      BankAccountNum: accountNum,
      StartDate: startDate,
      EndDate: endDate,
      CountPerPage: COUNT_PER_PAGE,
      CurrentPage: currentPage,
      OrderDirection: orderDirection,
    })) as [Record<string, Record<string, unknown>>];

    const payload = result.GetPeriodBankAccountLogExResult;
    if (!payload) break;

    const pageNum = Number(payload.CurrentPage ?? 0);
    throwIfErrorCode(pageNum, "입출금내역 조회");

    maxPageNum = Number(payload.MaxPageNum ?? 1);
    const wrapper = payload.BankAccountLogList as Record<string, unknown> | undefined;
    rows.push(
      // 여기는 반대로 요소명이 `BankAccountLogEx`다(계좌 목록과 규칙이 일관되지 않다) —
      // 마찬가지로 두 키를 모두 본다.
      ...normalizeList(wrapper?.BankAccountLogEx ?? wrapper?.BankAccountLog).map((raw) => ({
        accountNum: s(raw.BankAccountNum) || accountNum,
        transDT: s(raw.TransDT),
        deposit: n(raw.Deposit),
        withdraw: n(raw.Withdraw),
        balance: n(raw.Balance),
        transType: s(raw.TransType),
        transOffice: s(raw.TransOffice),
        transRemark: s(raw.TransRemark),
        transRefKey: s(raw.TransRefKey),
        mgtRemark1: s(raw.MgtRemark1),
        mgtRemark2: s(raw.MgtRemark2),
      }))
    );

    currentPage++;
    if (currentPage > MAX_PAGES && currentPage <= maxPageNum) {
      truncated = true;
      break;
    }
  } while (currentPage <= maxPageNum);

  return { rows, truncated };
}
