"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  BarChart3,
  Bot,
  Boxes,
  CalendarClock,
  ChevronDown,
  ClipboardCheck,
  FileText,
  ImageIcon,
  LayoutDashboard,
  LogOut,
  MessageSquareText,
  Settings,
  Share2,
  Send,
  Sparkles,
  Trash2,
  Users,
} from "lucide-react";
import { AuthGuard, useUser } from "./auth-guard";
import { cn } from "./ui";

const navigation = [
  { href: "/dashboard", label: "工作台", icon: LayoutDashboard },
  { href: "/content/create", label: "AI 内容生产", icon: Sparkles },
  { href: "/tasks", label: "任务中心", icon: BarChart3 },
  { href: "/reviews", label: "人工复核", icon: ClipboardCheck },
  { href: "/tasks/trash", label: "回收站", icon: Trash2 },
  {
    href: "/automations",
    label: "定时任务",
    icon: CalendarClock,
    adminOnly: true,
  },
  { href: "/assets", label: "内容资产", icon: FileText },
  { href: "/image-studio", label: "图片工坊", icon: ImageIcon },
  {
    href: "/wechat-ending",
    label: "公众号结尾",
    icon: MessageSquareText,
  },
  {
    href: "/channels",
    label: "渠道管理",
    icon: Share2,
  },
  {
    href: "/distribution",
    label: "多账号发布",
    icon: Send,
  },
  { href: "/members", label: "成员管理", icon: Users, adminOnly: true },
  { href: "/settings", label: "系统设置", icon: Settings },
];

function isNavigationActive(pathname: string, href: string) {
  if (href === "/tasks/trash") return pathname === href;
  if (href === "/tasks")
    return (
      pathname === href ||
      (pathname.startsWith(`${href}/`) && pathname !== "/tasks/trash")
    );
  return pathname === href || pathname.startsWith(`${href}/`);
}

function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const user = useUser();
  const [accountOpen, setAccountOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const visible = navigation.filter(
    (item) => !item.adminOnly || user?.role === "admin",
  );

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!accountMenuRef.current?.contains(event.target as Node))
        setAccountOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  async function logout() {
    if (!window.confirm("确认退出当前账号？未提交的表单内容将不会保存。"))
      return;
    setLoggingOut(true);
    const csrf = (await fetch("/api/auth/csrf").then((r) => r.json())) as {
      csrfToken: string;
    };
    await fetch("/api/auth/logout", {
      method: "POST",
      headers: { "x-csrf-token": csrf.csrfToken },
    });
    router.replace("/login");
  }

  return (
    <div className="min-h-screen bg-[#f7f7f8]">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col border-r border-[#e6e6e9] bg-white lg:flex">
        <div className="flex h-[82px] items-center border-b border-[#eeeeef] px-6">
          <Image
            src="/brand/geekdance-logo.png"
            alt="极客跳动"
            width={148}
            height={42}
            priority
            className="h-auto w-[148px] object-contain object-left"
          />
        </div>
        <div className="px-5 pt-6">
          <div className="rounded-2xl bg-[#17171a] px-4 py-3.5 text-white">
            <div className="flex items-center gap-2 text-[13px] font-semibold">
              <Bot size={16} className="text-[#ff3343]" />
              AI 运营中心
            </div>
            <p className="mt-1.5 text-[11px] leading-5 text-white/55">
              内容生产 · 素材处理 · 草稿管理
            </p>
          </div>
        </div>
        <nav className="mt-5 flex-1 space-y-1 px-4">
          {visible.map(({ href, label, icon: Icon }) => {
            const active = isNavigationActive(pathname, href);
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "focus-ring flex h-11 items-center gap-3 rounded-xl px-3.5 text-sm font-medium transition",
                  active
                    ? "bg-[#fff1f2] text-[#d00011]"
                    : "text-[#5d5d66] hover:bg-[#f5f5f6] hover:text-[#17171a]",
                )}
              >
                <Icon size={18} strokeWidth={active ? 2.2 : 1.8} />
                {label}
                {active && (
                  <span className="ml-auto h-5 w-1 rounded-full bg-[#e60012]" />
                )}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-[#eeeeef] p-4">
          <button
            onClick={() => setAccountOpen(true)}
            className="focus-ring flex w-full items-center gap-3 rounded-xl p-2.5 text-left hover:bg-[#f7f7f8]"
          >
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#17171a] text-xs font-bold text-white">
              {user?.name.slice(0, 1)}
            </span>
            <span className="min-w-0 flex-1">
              <strong className="block truncate text-sm">{user?.name}</strong>
              <span className="block truncate text-[11px] text-[#85858e]">
                {user?.role === "admin" ? "管理员" : "运营成员"}
              </span>
            </span>
            <Settings size={16} className="text-[#85858e]" />
          </button>
        </div>
      </aside>
      <div className="lg:pl-[248px]">
        <header className="sticky top-0 z-20 flex h-[82px] items-center justify-between border-b border-[#e6e6e9] bg-white/90 px-5 backdrop-blur-xl sm:px-8">
          <div className="flex items-center gap-3 lg:hidden">
            <Image
              src="/brand/geekdance-logo.png"
              alt="极客跳动"
              width={128}
              height={36}
              className="h-auto w-[128px]"
            />
          </div>
          <div className="hidden items-center gap-2 text-xs text-[#85858e] lg:flex">
            <Boxes size={15} />
            极客跳动内部工作区<span className="text-[#c7c7cc]">/</span>
            <strong className="font-semibold text-[#44444b]">
              {navigation.find((item) =>
                isNavigationActive(pathname, item.href),
              )?.label ?? "运营中心"}
            </strong>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden rounded-full border border-[#e8e8eb] bg-[#fafafa] px-3 py-1.5 text-xs text-[#666a73] sm:inline-flex">
              系统运行正常
            </span>
            <div ref={accountMenuRef} className="relative">
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={accountOpen}
                onClick={() => setAccountOpen((current) => !current)}
                className="focus-ring flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium hover:bg-[#f7f7f8]"
              >
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-[#17171a] text-xs font-bold text-white">
                  {user?.name.slice(0, 1)}
                </span>
                <span className="hidden sm:inline">{user?.name}</span>
                <ChevronDown
                  size={14}
                  className={`transition ${accountOpen ? "rotate-180" : ""}`}
                />
              </button>
              {accountOpen && (
                <div
                  role="menu"
                  className="absolute right-0 top-[calc(100%+10px)] z-40 w-64 rounded-2xl border border-[#e6e6e9] bg-white p-2 shadow-[0_18px_50px_rgba(23,23,26,.14)]"
                >
                  <div className="px-3 py-2.5">
                    <strong className="block truncate text-sm">
                      {user?.name}
                    </strong>
                    <span className="mt-1 block truncate text-xs text-[#85858e]">
                      {user?.email}
                    </span>
                    <span className="mt-1 block text-[11px] text-[#85858e]">
                      {user?.role === "admin" ? "管理员" : "运营成员"}
                    </span>
                  </div>
                  <div className="my-1 border-t border-[#ededf0]" />
                  <Link
                    role="menuitem"
                    href="/settings"
                    onClick={() => setAccountOpen(false)}
                    className="focus-ring flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-sm hover:bg-[#f7f7f8]"
                  >
                    <Settings size={16} />
                    账号与安全
                  </Link>
                  <button
                    role="menuitem"
                    type="button"
                    disabled={loggingOut}
                    onClick={() => void logout()}
                    className="focus-ring flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-sm text-[#b90012] hover:bg-[#fff1f2] disabled:opacity-60"
                  >
                    <LogOut size={16} />
                    {loggingOut ? "正在退出…" : "退出登录"}
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>
        <div className="overflow-x-auto border-b border-[#e6e6e9] bg-white px-4 py-2 lg:hidden">
          <nav className="flex min-w-max gap-1">
            {visible.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className={cn(
                  "rounded-lg px-3 py-2 text-xs font-medium",
                  isNavigationActive(pathname, href)
                    ? "bg-[#fff1f2] text-[#d00011]"
                    : "text-[#666a73]",
                )}
              >
                {label}
              </Link>
            ))}
          </nav>
        </div>
        <main className="mx-auto max-w-[1480px] p-5 sm:p-8 xl:p-10">
          {children}
        </main>
      </div>
    </div>
  );
}

export function PortalShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <Shell>{children}</Shell>
    </AuthGuard>
  );
}
