"use client";

import { sortMark, type SortState } from "@/lib/tableSort";

// 정렬 가능한 <th>. 모든 표에서 같은 모양·같은 클릭 동작(오름차순 → 내림차순 → 해제)을 쓰도록
// 컴포넌트로 뽑았다. 정렬 대상이 아닌 열(관리·삭제 버튼 열 등)은 그냥 <th>를 쓴다.
export function SortableTh<K extends string>({
  label,
  sortKey,
  state,
  onSort,
  align = "left",
  className = "",
}: {
  label: string;
  sortKey: K;
  state: SortState<K>;
  onSort: (key: K) => void;
  align?: "left" | "right";
  className?: string;
}) {
  const active = state?.key === sortKey;
  return (
    <th
      // 정렬 중인 열은 글자색을 진하게 해서, 화살표를 못 보고도 어느 기준으로 정렬됐는지 알 수 있게 한다.
      className={`cursor-pointer select-none py-2 pr-3 whitespace-nowrap hover:text-fg ${
        align === "right" ? "text-right" : "text-left"
      } ${active ? "text-fg" : ""} ${className}`}
      onClick={() => onSort(sortKey)}
      // 표 헤더는 키보드로도 눌러야 한다 — 클릭만 되면 키보드 사용자는 정렬을 쓸 수 없다.
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSort(sortKey);
        }
      }}
      aria-sort={active ? (state?.dir === "asc" ? "ascending" : "descending") : "none"}
      title={`${label} 기준 정렬 (클릭: 오름차순 → 내림차순 → 해제)`}
    >
      {label}
      {sortMark(state, sortKey)}
    </th>
  );
}
