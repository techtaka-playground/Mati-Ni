import { redirect } from "next/navigation";

export default function Home() {
  // 대시보드는 메뉴에서 뺀 상태라(2026-08-27, 나중에 업데이트 예정) 기본 진입 화면도
  // 손익조회로 바꿨다.
  redirect("/pnl");
}
