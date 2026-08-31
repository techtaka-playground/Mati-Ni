"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { logout } from "@/app/login/actions";
import type { PermissionField } from "@/lib/permissions";
import {
  IconTrendingUp,
  IconDocument,
  IconBox,
  IconReceipt,
  IconBank,
  IconBuilding,
  IconUserCog,
  IconUser,
  IconLogOut,
  IconChevronLeft,
  IconChevronRight,
} from "@/components/icons";

type SidebarUser = { email: string; role: string } & Record<PermissionField, boolean>;

const NAV: {
  href: string;
  label: string;
  Icon: (props: { className?: string }) => React.ReactElement;
  requires?: "admin" | PermissionField;
}[] = [
  // 대시보드는 나중에 다시 업데이트할 예정이라 메뉴에서 뺐다(2026-08-27) — 페이지 코드
  // 자체는 지우지 않고 남겨둠, 링크만 없앤 상태.
  { href: "/pnl", label: "손익조회", Icon: IconTrendingUp, requires: "canViewPnl" },
  { href: "/vouchers", label: "일반전표", Icon: IconDocument, requires: "canViewVouchers" },
  { href: "/customs", label: "관세전표", Icon: IconBox, requires: "canViewCustoms" },
  { href: "/tax-invoices", label: "세금계산서", Icon: IconReceipt, requires: "canViewTaxInvoices" },
  { href: "/bank", label: "입출금내역", Icon: IconBank, requires: "canViewBankLogs" },
  { href: "/parties", label: "거래처", Icon: IconBuilding, requires: "canViewParties" },
  { href: "/users", label: "사용자 관리", Icon: IconUserCog, requires: "admin" },
];

// 탭별 "마지막으로 보고 있던 위치"를 기억하는 키. sessionStorage를 쓰는 이유: 브라우저 탭을
// 닫으면 지워져서, 다음에 새로 열었을 때 몇 주 전 조회조건이 남아있는 일이 없다.
const LAST_URL_KEY = "matiNi:lastUrl:";
const COLLAPSED_KEY = "matiNi:sidebarCollapsed";

export function Sidebar({ user }: { user: SidebarUser }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [collapsed, setCollapsed] = useState(false);

  // localStorage는 클라이언트에만 있어서 마운트 후에 동기화 — 서버 렌더와 다를 수 있는
  // 값은 useEffect에서 읽어야 하이드레이션 경고가 안 남.
  useEffect(() => {
    if (localStorage.getItem(COLLAPSED_KEY) === "1") setCollapsed(true);
  }, []);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
      return next;
    });
  }
  // 탭을 떠났다 돌아오면 조회조건(월·구분 등)이 그대로 유지되도록, 각 탭에서 마지막으로 보던
  // 전체 URL(쿼리스트링 포함)을 기억해두고 사이드바 링크를 그 주소로 바꿔둔다. 조회조건을
  // URL에 담는 탭(세금계산서·손익조회)은 이것만으로 자동으로 복원된다.
  const [lastUrls, setLastUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    const item = NAV.find((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
    if (!item) return;
    const qs = searchParams.toString();
    const full = qs ? `${item.href}?${qs}` : item.href;
    sessionStorage.setItem(LAST_URL_KEY + item.href, full);
    setLastUrls((prev) => (prev[item.href] === full ? prev : { ...prev, [item.href]: full }));
  }, [pathname, searchParams]);

  // 다른 탭들의 기억된 위치는 마운트 시 한 번 읽어온다(sessionStorage는 서버에 없으므로
  // 렌더 중에 읽으면 하이드레이션 불일치가 난다 — 반드시 effect에서 읽는다).
  useEffect(() => {
    const restored: Record<string, string> = {};
    for (const item of NAV) {
      const saved = sessionStorage.getItem(LAST_URL_KEY + item.href);
      if (saved) restored[item.href] = saved;
    }
    setLastUrls((prev) => ({ ...restored, ...prev }));
  }, []);

  const nav = NAV.filter((item) => {
    if (!item.requires) return true;
    if (item.requires === "admin") return user.role === "admin";
    return user[item.requires];
  });

  const railIconBase =
    "flex h-10 w-10 items-center justify-center rounded-xl text-gray-40 hover:bg-gray-95 hover:text-fg";
  const railIconActive =
    "flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-accent-fg";

  if (collapsed) {
    return (
      <aside className="flex w-16 shrink-0 flex-col items-center gap-1 bg-surface py-4">
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label="사이드바 펼치기"
          title="펼치기"
          className={`${railIconBase} mb-3`}
        >
          <IconChevronRight className="h-5 w-5" />
        </button>

        <nav className="flex flex-col items-center gap-1">
          {nav.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={lastUrls[item.href] ?? item.href}
                title={item.label}
                className={active ? railIconActive : railIconBase}
              >
                <item.Icon className="h-5 w-5" />
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto flex flex-col items-center gap-1">
          <Link href="/account" title="계정" className={railIconBase}>
            <IconUser className="h-5 w-5" />
          </Link>
          <form action={logout}>
            <button type="submit" title="로그아웃" className={railIconBase}>
              <IconLogOut className="h-5 w-5" />
            </button>
          </form>
        </div>
      </aside>
    );
  }

  return (
    <aside className="relative flex w-56 shrink-0 flex-col bg-surface p-4">
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-label="사이드바 접기"
        className="absolute top-4 right-3 flex h-7 w-7 items-center justify-center rounded-full text-muted hover:bg-gray-95 hover:text-fg"
      >
        <IconChevronLeft className="h-4 w-4" />
      </button>

      <div className="mb-6 px-2">
        <h1 className="text-xl font-bold text-fg">Mati-Ni</h1>
        <div className="mt-1 text-xs font-semibold text-accent">Sol made it</div>
      </div>
      <nav className="flex flex-col gap-1">
        {nav.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={lastUrls[item.href] ?? item.href}
              className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm ${
                active
                  ? "bg-accent-soft font-medium text-accent-hover"
                  : "text-gray-30 hover:bg-gray-95 hover:text-fg"
              }`}
            >
              <item.Icon className="h-5 w-5 shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto border-t border-border pt-3">
        <div className="mb-2 truncate px-2 text-xs text-muted" title={user.email}>
          {user.email}
        </div>
        <Link
          href="/account"
          className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-gray-30 hover:bg-gray-95 hover:text-fg"
        >
          <IconUser className="h-5 w-5 shrink-0" />
          계정
        </Link>
        <form action={logout}>
          <button
            type="submit"
            className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-gray-30 hover:bg-gray-95 hover:text-fg"
          >
            <IconLogOut className="h-5 w-5 shrink-0" />
            로그아웃
          </button>
        </form>
      </div>
    </aside>
  );
}
