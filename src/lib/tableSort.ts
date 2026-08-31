// 목록 화면의 열 정렬(오름차순/내림차순)을 모든 표에서 같은 규칙으로 처리하기 위한 공용 헬퍼.
// 화면마다 따로 구현하면 "빈 값이 어디로 가는지", "세 번째 클릭에 무슨 일이 일어나는지"가
// 표마다 달라져서 쓰는 사람이 매번 새로 배워야 한다.

export type SortDir = "asc" | "desc";
export type SortState<K extends string = string> = { key: K; dir: SortDir } | null;

// 정렬 값으로 쓸 수 있는 타입. Date는 숫자로, 그 외는 문자열로 비교한다.
export type SortValue = string | number | Date | null | undefined;

// 헤더 클릭 한 번 = 오름차순 → 두 번 = 내림차순 → 세 번 = 정렬 해제(원래 순서).
// 정렬 해제를 넣은 이유: 표마다 기본 순서에 의미가 있다(전표는 최근 날짜부터, 손익은 이익
// 큰 순 등). 한 번 정렬하면 그 기본 순서로 되돌릴 방법이 없으면 새로고침해야 한다.
export function toggleSort<K extends string>(prev: SortState<K>, key: K): SortState<K> {
  if (!prev || prev.key !== key) return { key, dir: "asc" };
  if (prev.dir === "asc") return { key, dir: "desc" };
  return null;
}

// 헤더에 붙는 방향 표시. 정렬 중이 아닌 열에는 아무것도 붙이지 않는다.
export function sortMark<K extends string>(state: SortState<K>, key: K): string {
  if (!state || state.key !== key) return "";
  return state.dir === "asc" ? " ↑" : " ↓";
}

function normalize(v: SortValue): { empty: boolean; num: number | null; str: string } {
  if (v === null || v === undefined) return { empty: true, num: null, str: "" };
  if (v instanceof Date) return { empty: false, num: v.getTime(), str: "" };
  if (typeof v === "number") return { empty: false, num: Number.isFinite(v) ? v : null, str: "" };
  const s = v.trim();
  if (s === "" || s === "-") return { empty: true, num: null, str: "" };
  return { empty: false, num: null, str: s };
}

// 두 값을 오름차순 기준으로 비교한다. 규칙:
//  - 빈 값(null/""/"-")은 **정렬 방향과 무관하게 항상 뒤로** 보낸다. 내림차순으로 뒤집을 때
//    빈 행이 맨 위로 올라와 실제 데이터를 가리는 게 제일 불편해서다.
//  - 숫자끼리는 숫자로, 그 외는 localeCompare(ko, 숫자 포함)로 비교한다 — "10" < "9"가 되는
//    사전식 비교를 피하려고 numeric 옵션을 켠다(B/L 번호·거래처코드에 실제로 영향이 있다).
export function compareValues(a: SortValue, b: SortValue): number {
  const x = normalize(a);
  const y = normalize(b);
  if (x.empty && y.empty) return 0;
  if (x.empty) return 1;
  if (y.empty) return -1;
  if (x.num !== null && y.num !== null) return x.num - y.num;
  return x.str.localeCompare(y.str, "ko", { numeric: true, sensitivity: "base" });
}

// 정렬되지 않은 상태면 원본 배열을 그대로 돌려준다(복사도 하지 않는다 — 호출부에서 참조
// 동일성으로 "정렬 안 됨"을 판단할 수 있게).
export function sortRowsBy<T, K extends string>(
  rows: T[],
  state: SortState<K>,
  valueOf: (row: T, key: K) => SortValue
): T[] {
  if (!state) return rows;
  const factor = state.dir === "asc" ? 1 : -1;
  // Array.prototype.sort는 안정 정렬이라, 값이 같은 행들의 원래 순서는 유지된다.
  return [...rows].sort((a, b) => compareValues(valueOf(a, state.key), valueOf(b, state.key)) * factor);
}

// 여러 줄이 한 논리행(전표 1건이 B/L별로 펼쳐진 줄들, 관세대납 1건 + 회수 줄들)을 이루는 표를
// 위한 정렬. 줄 단위로 정렬하면 같은 전표의 줄들이 뿔뿔이 흩어져 왼쪽 연결선이 무의미해지므로,
// **묶음 단위로 정렬하고 묶음 안쪽 순서는 건드리지 않는다.** 정렬 값은 묶음의 첫 줄에서 뽑는다.
export function sortGroupedRowsBy<T, K extends string>(
  rows: T[],
  state: SortState<K>,
  groupKeyOf: (row: T) => string,
  valueOf: (row: T, key: K) => SortValue
): T[] {
  if (!state) return rows;
  const groups: { key: string; rows: T[] }[] = [];
  const byKey = new Map<string, { key: string; rows: T[] }>();
  for (const r of rows) {
    const gk = groupKeyOf(r);
    let g = byKey.get(gk);
    if (!g) {
      g = { key: gk, rows: [] };
      byKey.set(gk, g);
      groups.push(g);
    }
    g.rows.push(r);
  }
  const factor = state.dir === "asc" ? 1 : -1;
  groups.sort((a, b) => compareValues(valueOf(a.rows[0], state.key), valueOf(b.rows[0], state.key)) * factor);
  return groups.flatMap((g) => g.rows);
}
