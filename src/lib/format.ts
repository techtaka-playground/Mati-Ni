export function formatAmount(n: number): string {
  return Math.round(n).toLocaleString("ko-KR");
}

// "YYYY-MM-DD" 문자열을 그 날짜의 UTC 자정으로 고정한다 — 로컬 시간대 보정 때문에
// 날짜가 하루 밀리거나 당겨지는 것을 막기 위함 (월별 손익 집계가 날짜 그대로여야 함).
export function parseDateInput(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function monthOf(d: Date): string {
  return d.toISOString().slice(0, 7);
}

// "월" 조회 모드에서 고른 월 하나("YYYY-MM")를 그 달 1일~말일 범위로 바꾼다 — 일반전표·
// 관세전표·입출금내역이 모두 같은 방식으로 "월/일" 조회를 전환하므로 여기 한 곳에 둔다
// (2026-08-27).
export function monthRange(month: string): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return { start: `${month}-01`, end: `${month}-${String(lastDay).padStart(2, "0")}` };
}

// 입력 중인 문자열에 천단위 콤마를 실시간으로 붙인다. 음수·소수점 입력을 허용.
export function commaInput(raw: string): string {
  const negative = raw.trim().startsWith("-");
  const cleaned = raw.replace(/[^0-9.]/g, "");
  const [intPart, ...rest] = cleaned.split(".");
  const withCommas = (intPart || "").replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const decimal = rest.length > 0 ? `.${rest.join("").slice(0, 2)}` : "";
  return `${negative ? "-" : ""}${withCommas}${decimal}`;
}

export function numOf(formatted: string): number {
  const n = Number(formatted.replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

// 사업자등록번호는 들어오는 경로마다 형식이 다르다 — 홈택스 엑셀은 "201-81-90365"(하이픈
// 있음), 바로빌 API는 "2018190365"(하이픈 없음)로 준다. 같은 사업자가 형식만 달라 서로 다른
// 거래처로 중복 등록되고, 세금계산서 열람권한 대조(bizNo === corpNum)도 어긋나던 문제가
// 실제로 있었다(프로라인해운이 0001/0037로 두 번 등록됨). 그래서:
//  - 비교·조회는 항상 숫자만 뽑아서(bizNoDigits) 형식과 무관하게 맞춘다.
//  - 저장·표시는 항상 000-00-00000(formatBizNo)로 통일한다.
// 거래처는 어느 화면에서든 "[코드] 이름"으로 똑같이 보여준다 — 코드가 아직 없는 거래처
// (수기 등록 직후 등)는 이름만 보여준다.
export function formatPartyLabel(code: string | null | undefined, name: string): string {
  return code ? `[${code}] ${name}` : name;
}

export function bizNoDigits(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\D/g, "");
}

export function formatBizNo(raw: string | null | undefined): string {
  const d = bizNoDigits(raw);
  if (d.length !== 10) return (raw ?? "").trim(); // 10자리가 아니면 손대지 않고 원본 유지
  return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
}
