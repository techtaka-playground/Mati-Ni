import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/sessionToken";

// 1차 방어선: 로그인 안 됐으면 무조건 /login으로 보낸다. Server Action은 proxy matcher로
// 걸러지지 않을 수 있다는 Next.js 공식 안내에 따라, 실제 권한 검증(예: 세금계산서 열람)은
// (app)/layout.tsx와 각 페이지에서 DB로 다시 확인한다(getCurrentUserFresh) — 여긴 "로그인
// 됐는가"만 빠르게 판단하는 stateless 체크다.
export default function proxy(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (verifySessionToken(token)) return NextResponse.next();

  const loginUrl = new URL("/login", request.url);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!login|invite|_next/static|_next/image|favicon.ico).*)"],
};
