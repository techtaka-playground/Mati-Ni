// 손익조회 세 탭(월별/B/L별/거래처별)의 "보고서 다운로드"가 만드는 인쇄용 HTML — bankSlip.ts와
// 같은 방식이다: PDF 생성 라이브러리를 새로 넣지 않고 브라우저의 "인쇄 → PDF로 저장"을 그대로
// 다운로드로 쓴다(한글 폰트 문제도 없다 — 브라우저가 이미 렌더링 중이므로). "엑셀 다운로드"가
// 원본 데이터를 그대로 내려받는 것이라면, 이건 그 데이터를 사람이 읽고 공유하기 좋은 문서
// 한 장으로 정리한 것 — 회사명·조회조건·작성자·작성일시를 밝힌 표지 성격의 머리말과, 합계를
// 한눈에 보는 요약 박스, 그 아래 상세 표로 구성한다.

function esc(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function won(v: number): string {
  return `${Math.round(v).toLocaleString("ko-KR")}원`;
}

function marginPct(profit: number, saleAmount: number): string {
  if (saleAmount === 0) return "-";
  return `${((profit / saleAmount) * 100).toFixed(1)}%`;
}

// globals.css의 --pos/--neg와 같은 색이다(인쇄용 HTML은 앱 CSS 밖에서 렌더되므로 값을
// 그대로 복제해뒀다 — 바꾸려면 양쪽 다 고쳐야 함).
const POS = "#2f6f4f";
const NEG = "#a23c34";

type ReportMeta = {
  corpName: string;
  generatedByEmail: string;
  periodLabel: string; // 예: "2026-08-01 ~ 2026-08-31" 또는 "전체 기간"
  partyFilterLabel: string | null; // 거래처 필터가 걸려 있으면 "[0001] 이너시아" 형태
  printedAt: Date;
};

type Totals = { saleAmount: number; purchaseAmount: number; profit: number; count: number };

function printedAtStr(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 문서 전체의 공통 틀(표지 머리말 + 요약 박스 + 인쇄 스크립트) — 상세 표(tableHtml)만 탭마다
// 다르게 끼워 넣는다.
function reportShell(input: {
  title: string;
  meta: ReportMeta;
  totals: Totals;
  tableHtml: string;
}): string {
  const { title, meta, totals, tableHtml } = input;
  const profitColor = totals.profit >= 0 ? POS : NEG;

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>${esc(title)} ${esc(printedAtStr(meta.printedAt))}</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "Malgun Gothic", "맑은 고딕", system-ui, sans-serif;
    color: #111;
    font-size: 10.5pt;
  }
  h1 { margin: 0; font-size: 16pt; font-weight: 700; letter-spacing: -0.02em; }
  .corp { font-size: 10pt; color: #555; margin-top: 2px; }
  .top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .issued { font-size: 8pt; color: #666; text-align: right; white-space: nowrap; margin-top: 3px; }
  .meta { margin: 6mm 0 5mm; font-size: 9.5pt; color: #333; display: flex; gap: 14px; flex-wrap: wrap; }
  .meta b { color: #111; font-weight: 700; }
  .summary { display: flex; gap: 0; margin-bottom: 6mm; border: 1px solid #333; }
  .summary .cell { flex: 1; padding: 7px 10px; border-right: 1px solid #ccc; }
  .summary .cell:last-child { border-right: none; }
  .summary .cell .k { font-size: 8.5pt; color: #666; }
  .summary .cell .v { font-size: 12pt; font-weight: 700; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #999; padding: 5px 7px; font-size: 9.5pt; }
  th { background: #f2f2f2; font-weight: 700; white-space: nowrap; }
  td.r, th.r { text-align: right; }
  tfoot td { font-weight: 700; background: #fafafa; }
  .note { margin-top: 6mm; padding-top: 3mm; border-top: 1px dotted #999; font-size: 8pt; color: #666; }
  .btn { margin-bottom: 6mm; text-align: right; }
  .btn button { padding: 7px 16px; font-size: 10pt; cursor: pointer; }
  @media print { .btn { display: none; } thead { display: table-header-group; } }
</style>
</head>
<body>
  <div class="btn"><button onclick="window.print()">인쇄 / PDF로 저장</button></div>

  <div class="top">
    <div>
      <h1>${esc(title)}</h1>
      <div class="corp">${esc(meta.corpName)}</div>
    </div>
    <div class="issued">작성일시 : ${esc(printedAtStr(meta.printedAt))}<br>작성자 : ${esc(meta.generatedByEmail)}</div>
  </div>

  <div class="meta">
    <span>조회기간 : <b>${esc(meta.periodLabel)}</b></span>
    ${meta.partyFilterLabel ? `<span>거래처 : <b>${esc(meta.partyFilterLabel)}</b></span>` : ""}
  </div>

  <div class="summary">
    <div class="cell"><div class="k">건수</div><div class="v">${totals.count.toLocaleString("ko-KR")}건</div></div>
    <div class="cell"><div class="k">매출액</div><div class="v">${won(totals.saleAmount)}</div></div>
    <div class="cell"><div class="k">배분매입액</div><div class="v">${won(totals.purchaseAmount)}</div></div>
    <div class="cell"><div class="k">손익</div><div class="v" style="color:${profitColor}">${won(totals.profit)}</div></div>
    <div class="cell"><div class="k">손익률</div><div class="v" style="color:${profitColor}">${marginPct(totals.profit, totals.saleAmount)}</div></div>
  </div>

  ${tableHtml}

  <div class="note">
    이 보고서는 Mati-Ni(사내 정산 프로그램)에서 생성됐습니다 — 화면의 조회 결과를 그대로 옮긴 참고 자료이며, 세금계산서·전표 원본이 아닙니다.
  </div>

  <script>
    window.addEventListener("load", function () { window.print(); });
  </script>
</body>
</html>`;
}

export type PnlReportSummaryRow = {
  key: string;
  code: string | null;
  label: string;
  count: number;
  saleAmount: number;
  purchaseAmount: number;
  profit: number;
};

// 월별/거래처별 — 두 탭이 행 모양이 같아서(코드 유무만 다름) 하나로 합친다(PnlSummaryTable과
// 같은 방식).
export function buildPnlSummaryReportHtml(input: {
  title: string;
  labelHeader: string;
  codeHeader?: string;
  rows: PnlReportSummaryRow[];
  meta: ReportMeta;
}): string {
  const { title, labelHeader, codeHeader, rows, meta } = input;
  const totals = rows.reduce(
    (acc, r) => ({
      saleAmount: acc.saleAmount + r.saleAmount,
      purchaseAmount: acc.purchaseAmount + r.purchaseAmount,
      profit: acc.profit + r.profit,
      count: acc.count + r.count,
    }),
    { saleAmount: 0, purchaseAmount: 0, profit: 0, count: 0 }
  );

  const bodyRows = rows
    .map(
      (r) => `<tr>
        ${codeHeader ? `<td>${esc(r.code ?? "-")}</td>` : ""}
        <td>${esc(r.label)}</td>
        <td class="r">${r.count.toLocaleString("ko-KR")}</td>
        <td class="r">${won(r.saleAmount)}</td>
        <td class="r">${won(r.purchaseAmount)}</td>
        <td class="r" style="color:${r.profit >= 0 ? POS : NEG}">${won(r.profit)}</td>
        <td class="r" style="color:${r.profit >= 0 ? POS : NEG}">${marginPct(r.profit, r.saleAmount)}</td>
      </tr>`
    )
    .join("\n");

  const tableHtml = `<table>
    <thead>
      <tr>
        ${codeHeader ? `<th>${esc(codeHeader)}</th>` : ""}
        <th>${esc(labelHeader)}</th>
        <th class="r">건수</th>
        <th class="r">매출액</th>
        <th class="r">배분매입액</th>
        <th class="r">손익</th>
        <th class="r">손익률</th>
      </tr>
    </thead>
    <tbody>${bodyRows}</tbody>
    <tfoot>
      <tr>
        <td colspan="${codeHeader ? 2 : 1}">합계</td>
        <td class="r">${totals.count.toLocaleString("ko-KR")}</td>
        <td class="r">${won(totals.saleAmount)}</td>
        <td class="r">${won(totals.purchaseAmount)}</td>
        <td class="r" style="color:${totals.profit >= 0 ? POS : NEG}">${won(totals.profit)}</td>
        <td class="r" style="color:${totals.profit >= 0 ? POS : NEG}">${marginPct(totals.profit, totals.saleAmount)}</td>
      </tr>
    </tfoot>
  </table>`;

  return reportShell({ title, meta, totals, tableHtml });
}

export type PnlReportBlRow = {
  saleId: string;
  date: string;
  blNo: string;
  partyCode: string | null;
  partyName: string;
  saleAmount: number;
  purchaseAmount: number;
  profit: number;
};

export function buildPnlBlReportHtml(input: { rows: PnlReportBlRow[]; meta: ReportMeta }): string {
  const { rows, meta } = input;
  const totals = rows.reduce(
    (acc, r) => ({
      saleAmount: acc.saleAmount + r.saleAmount,
      purchaseAmount: acc.purchaseAmount + r.purchaseAmount,
      profit: acc.profit + r.profit,
      count: acc.count + 1,
    }),
    { saleAmount: 0, purchaseAmount: 0, profit: 0, count: 0 }
  );

  const bodyRows = rows
    .map(
      (r) => `<tr>
        <td>${esc(r.date)}</td>
        <td>${esc(r.blNo)}</td>
        <td>${esc(r.partyCode ?? "-")}</td>
        <td>${esc(r.partyName)}</td>
        <td class="r">${won(r.saleAmount)}</td>
        <td class="r">${won(r.purchaseAmount)}</td>
        <td class="r" style="color:${r.profit >= 0 ? POS : NEG}">${won(r.profit)}</td>
        <td class="r" style="color:${r.profit >= 0 ? POS : NEG}">${marginPct(r.profit, r.saleAmount)}</td>
      </tr>`
    )
    .join("\n");

  const tableHtml = `<table>
    <thead>
      <tr>
        <th>날짜</th><th>B/L</th><th>거래처코드</th><th>거래처명</th>
        <th class="r">매출액</th><th class="r">배분매입액</th><th class="r">손익</th><th class="r">손익률</th>
      </tr>
    </thead>
    <tbody>${bodyRows}</tbody>
    <tfoot>
      <tr>
        <td colspan="4">합계 (${rows.length.toLocaleString("ko-KR")}건)</td>
        <td class="r">${won(totals.saleAmount)}</td>
        <td class="r">${won(totals.purchaseAmount)}</td>
        <td class="r" style="color:${totals.profit >= 0 ? POS : NEG}">${won(totals.profit)}</td>
        <td class="r" style="color:${totals.profit >= 0 ? POS : NEG}">${marginPct(totals.profit, totals.saleAmount)}</td>
      </tr>
    </tfoot>
  </table>`;

  return reportShell({ title: "B/L별 손익 보고서", meta, totals, tableHtml });
}
