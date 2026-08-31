import type { BankLogRow } from "@/lib/barobillBank";

// 거래 1건을 A4 한 장짜리 "계좌 거래내역 확인서"로 만든다 — 은행 인터넷뱅킹에서 뽑는
// "계좌별거래내역 상세정보"와 **같은 항목·같은 배치**로 두어, 결의서에 첨부했을 때 눈으로
// 바로 대조되게 했다.
//
// 다만 **은행 로고나 은행 발행 문서 형식을 그대로 재현하지는 않는다.** 이 문서는 우리 앱이
// 바로빌 계좌조회 데이터로 만든 것이지 은행이 발행한 증빙이 아니어서, 은행 문서와 구분되지
// 않으면 안 되기 때문이다. 그래서 발행 주체를 Mati-Ni로 밝히고, 하단에 데이터 출처와
// 은행 거래고유번호(TransRefKey)를 적어 은행 원본과 대조할 수 있게 했다. 은행이 발행한
// 공식 증빙이 필요하면 인터넷뱅킹에서 받아야 한다.
//
// PDF 생성 라이브러리를 새로 넣지 않고 **인쇄용 HTML을 새 창으로 띄운다** — 브라우저의
// "PDF로 저장"이 곧 다운로드다. 한글 폰트 문제도 없다(브라우저가 이미 렌더링하고 있다).

// "20260818101218" → "2026.08.18 10:12:18"
export function formatSlipDT(raw: string): string {
  const d = raw.replace(/\D/g, "");
  if (d.length < 8) return raw;
  const date = `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}`;
  if (d.length < 14) return date;
  return `${date} ${d.slice(8, 10)}:${d.slice(10, 12)}:${d.slice(12, 14)}`;
}

// 계좌번호에 하이픈을 넣는다. 은행마다 자리수 규칙이 달라서 **확실한 경우에만** 넣고
// (신한 12자리 = 3-3-6), 나머지는 받은 값을 그대로 쓴다 — 잘못 끊어 넣으면 다른 계좌처럼
// 보여서 대조에 방해가 된다.
export function formatSlipAccountNum(accountNum: string, bankName: string): string {
  const d = accountNum.replace(/\D/g, "");
  if (bankName.includes("신한") && d.length === 12) {
    return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  }
  return accountNum;
}

// 은행이 주는 거래점/경유은행 값은 "(기업)", "(우리)"처럼 괄호로 싸여 오는 경우와 "여의도",
// "강남"처럼 그냥 오는 경우가 섞여 있다 — 괄호만 벗겨 통일한다. 표와 확인서가 같은 규칙을
// 쓰도록 여기서 export해서 BankLogSearchForm도 이걸 가져다 쓴다.
// **송금인 이름에는 절대 쓰지 않는다** — "(주)앱솔브랩"의 괄호는 상호의 일부다.
export function stripParens(raw: string): string {
  return raw.replace(/[()（）]/g, "").trim();
}

function won(v: number): string {
  return `${v.toLocaleString("ko-KR")} 원`;
}

function esc(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function buildBankSlipHtml(input: {
  corpName: string;
  bankName: string;
  accountNum: string;
  row: BankLogRow;
  printedAt: Date;
}): string {
  const { corpName, bankName, accountNum, row, printedAt } = input;
  const p = printedAt;
  const pad = (n: number) => String(n).padStart(2, "0");
  const printedStr =
    `${p.getFullYear()}.${pad(p.getMonth() + 1)}.${pad(p.getDate())} ` +
    `( ${pad(p.getHours())}:${pad(p.getMinutes())}:${pad(p.getSeconds())} )`;

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>계좌 거래내역 확인서 ${esc(printedStr)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "Malgun Gothic", "맑은 고딕", system-ui, sans-serif;
    color: #111;
    font-size: 11pt;
  }
  h1 { margin: 0; font-size: 17pt; font-weight: 700; text-align: center; letter-spacing: -0.02em; }
  .top { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; }
  .issued { width: 50mm; font-size: 8pt; color: #666; text-align: right; white-space: nowrap; }
  .meta { margin: 14mm 0 2mm; font-size: 9.5pt; }
  .meta b { font-weight: 700; }
  /* table-layout: fixed + colgroup으로 라벨 칸을 고정하고 값 칸 두 개를 균등하게 나눈다 —
     기본 auto 레이아웃이면 내용이 긴 칸이 표를 다 차지해서 은행 양식과 비율이 어긋난다. */
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { border: 1px solid #333; padding: 6px 9px; font-size: 10.5pt; overflow-wrap: anywhere; }
  th { width: 24mm; background: #f2f2f2; font-weight: 700; text-align: left; white-space: nowrap; }
  td.r { text-align: right; }
  .amount { font-weight: 700; }
  .note { margin-top: 8mm; padding-top: 4mm; border-top: 1px dotted #999; font-size: 8.5pt; color: #555; line-height: 1.7; }
  .note code { font-family: Consolas, monospace; font-size: 8.5pt; color: #111; }
  .btn { margin-bottom: 8mm; text-align: right; }
  .btn button { padding: 7px 16px; font-size: 10pt; cursor: pointer; }
  @media print { .btn { display: none; } }
</style>
</head>
<body>
  <div class="btn"><button onclick="window.print()">인쇄 / PDF로 저장</button></div>

  <div class="top">
    <div style="width:50mm"></div>
    <h1 style="flex:1">계좌 거래내역 확인서</h1>
    <div class="issued">발급시간 : ${esc(printedStr)}</div>
  </div>

  <div class="meta">
    <span>고객명 : <b>${esc(corpName)}</b></span>
  </div>

  <table>
    <colgroup>
      <col style="width:24mm"><col><col style="width:24mm"><col>
    </colgroup>
    <tbody>
      <tr>
        <th>거래일시</th>
        <td colspan="3">${esc(formatSlipDT(row.transDT))}</td>
      </tr>
      <tr>
        <th>계좌번호</th>
        <td>${esc(formatSlipAccountNum(accountNum, bankName))}${bankName ? ` (${esc(bankName)})` : ""}</td>
        <th>적요</th>
        <td>${esc(row.transType) || "-"}</td>
      </tr>
      <tr>
        <th>입금액</th>
        <td class="r amount">${won(row.deposit)}</td>
        <th>출금액</th>
        <td class="r amount">${won(row.withdraw)}</td>
      </tr>
      <tr>
        <th>거래점명</th>
        <td class="r">${esc(stripParens(row.transOffice)) || "-"}</td>
        <th>내용</th>
        <td>${esc(row.transRemark) || "-"}</td>
      </tr>
    </tbody>
  </table>

  <div class="note">
    은행 거래고유번호(대조용) : <code>${esc(row.transRefKey) || "(없음)"}</code>
  </div>

  <script>
    // 창이 열리면 바로 인쇄 대화상자를 띄운다(사용자가 취소하면 화면에 그대로 남아 다시 누를 수 있다).
    window.addEventListener("load", function () { window.print(); });
  </script>
</body>
</html>`;
}
