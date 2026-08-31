"use client";

import { useState } from "react";

// 조회조건 중 날짜 부분 — "일" 모드는 시작일·종료일 두 칸이고, "월" 모드는 세금계산서
// 화면의 조회년월과 같은 방식으로 그 달 전체를 한 번에 고른다(2026-08-27, 일반전표에서
// 처음 만들었고 관세전표도 같은 방식을 쓴다). 순수 GET 폼(<form method="get">) 안에서
// 동작해야 하므로, 선택하지 않은 모드의 입력은 아예 렌더링하지 않는다 — 렌더링된 입력만
// 그 이름으로 폼에 실려서, URL에는 지금 고른 모드의 값만 남는다.
export function DateModeFilterFields({
  defaultMode,
  defaultMonth,
  defaultStart,
  defaultEnd,
  children,
}: {
  defaultMode: "day" | "month";
  defaultMonth: string;
  defaultStart: string;
  defaultEnd: string;
  // "조회 방식" 다음, 날짜 입력 앞에 끼워 넣을 항목(예: 구분 선택) — 조회 방식 → 구분 → 날짜
  // 순서로 두기 위해 이 컴포넌트 안에서 그 사이에 그대로 렌더링한다(2026-08-27).
  children?: React.ReactNode;
}) {
  const [mode, setMode] = useState<"day" | "month">(defaultMode);
  const inputClass = "rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg";

  return (
    <>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted">조회 방식</label>
        <input type="hidden" name="mode" value={mode} />
        {/* 네모칸 하나 안에 월·일 두 선택지를 나란히 넣은 토글 — 라디오 버튼 대신 눌러서
            바로 바뀌는 버튼 형태로(2026-08-27). */}
        <div className="inline-flex rounded-md border border-border p-0.5">
          <button
            type="button"
            onClick={() => setMode("month")}
            className={`rounded px-3 py-1 text-sm transition-colors ${
              mode === "month" ? "bg-accent text-accent-fg" : "text-muted hover:text-fg"
            }`}
          >
            월
          </button>
          <button
            type="button"
            onClick={() => setMode("day")}
            className={`rounded px-3 py-1 text-sm transition-colors ${
              mode === "day" ? "bg-accent text-accent-fg" : "text-muted hover:text-fg"
            }`}
          >
            일
          </button>
        </div>
      </div>

      {children}

      {mode === "month" ? (
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted">조회년월</label>
          <input type="month" name="month" defaultValue={defaultMonth} className={inputClass} />
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted">시작일</label>
            <input type="date" name="start" defaultValue={defaultStart} className={inputClass} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted">종료일</label>
            <input type="date" name="end" defaultValue={defaultEnd} className={inputClass} />
          </div>
        </>
      )}
    </>
  );
}
