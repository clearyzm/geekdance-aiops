"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { ArrowRight, LockKeyhole, ShieldCheck, Sparkles } from "lucide-react";
import { Button, inputClass } from "@/components/ui";

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);
    const form = new FormData(event.currentTarget);
    try {
      const { csrfToken } = (await fetch("/api/auth/csrf").then((r) =>
        r.json(),
      )) as { csrfToken: string };
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify({
          email: form.get("email"),
          password: form.get("password"),
        }),
      });
      const data = (await response.json()) as {
        user?: { mustChangePassword: boolean };
        message?: string;
      };
      if (!response.ok) throw new Error(data.message ?? "登录失败");
      router.replace(
        data.user?.mustChangePassword
          ? "/settings?changePassword=1"
          : "/dashboard",
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "登录失败");
    } finally {
      setLoading(false);
    }
  }
  return (
    <main className="grid min-h-screen bg-white lg:grid-cols-[1.08fr_.92fr]">
      <section className="gd-grid relative hidden overflow-hidden bg-[#17171a] p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_15%,rgba(230,0,18,.3),transparent_32%),linear-gradient(145deg,rgba(23,23,26,.92),rgba(0,0,0,.98))]" />
        <div className="relative z-10">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-white/75">
            <Sparkles size={14} className="text-[#ff3343]" />
            GeekDance AI Operations
          </div>
          <h1 className="mt-8 max-w-[650px] text-5xl font-bold leading-[1.18] tracking-[-.05em]">
            极客跳动 AI
            <br />
            <span className="text-[#ff3343]">内容运营工作台</span>
          </h1>
          <p className="mt-6 max-w-xl text-base leading-8 text-white/55">
            面向极客跳动运营团队的内容生产与渠道草稿管理平台，统一完成资料核验、内容生成、品牌排版、人工复核与渠道草稿交付。
          </p>
        </div>
        <div className="relative z-10 grid max-w-2xl grid-cols-3 gap-3">
          {[
            ["01", "资料可追溯"],
            ["02", "流程可审核"],
            ["03", "草稿可管理"],
          ].map(([n, t]) => (
            <div
              key={n}
              className="rounded-2xl border border-white/10 bg-white/[.04] p-4"
            >
              <span className="text-xs font-bold text-[#ff3343]">{n}</span>
              <strong className="mt-7 block text-sm">{t}</strong>
            </div>
          ))}
        </div>
        <Image
          src="/brand/geekdance-mascot.png"
          alt="极客跳动吉祥物"
          width={270}
          height={270}
          className="absolute -bottom-7 right-8 z-10 h-auto w-[240px] opacity-20"
        />
      </section>
      <section className="flex min-h-screen items-center justify-center px-6 py-12 sm:px-12">
        <div className="w-full max-w-[420px]">
          <Image
            src="/brand/geekdance-logo.png"
            alt="极客跳动"
            width={174}
            height={48}
            className="h-auto w-[174px]"
            priority
          />
          <div className="mt-12">
            <h2 className="text-3xl font-bold tracking-[-.04em]">
              登录运营工作台
            </h2>
            <p className="mt-2 text-sm text-[#666a73]">
              使用极客跳动内部账号继续
            </p>
          </div>
          <form onSubmit={submit} className="mt-8 space-y-5">
            <label className="grid gap-2 text-sm font-semibold">
              工作邮箱
              <input
                required
                name="email"
                type="email"
                autoComplete="username"
                className={inputClass}
                placeholder="name@geekdance.cn"
              />
            </label>
            <label className="grid gap-2 text-sm font-semibold">
              密码
              <input
                required
                name="password"
                type="password"
                autoComplete="current-password"
                className={inputClass}
                placeholder="输入登录密码"
              />
            </label>
            {error && (
              <div
                role="alert"
                className="rounded-xl border border-[#f6b8be] bg-[#fff1f2] px-3.5 py-3 text-sm text-[#b90012]"
              >
                {error}
              </div>
            )}
            <Button type="submit" disabled={loading} className="w-full">
              {loading ? "正在登录…" : "登录运营工作台"}
              <ArrowRight size={17} />
            </Button>
          </form>
          <div className="mt-8 flex items-start gap-3 rounded-2xl bg-[#f7f7f8] p-4">
            <ShieldCheck size={20} className="mt-0.5 shrink-0 text-[#e60012]" />
            <p className="text-xs leading-5 text-[#666a73]">
              本系统仅供极客跳动授权成员使用。关键操作将记录审计日志，请妥善保管账号信息。
            </p>
          </div>
          <p className="mt-6 flex items-center gap-2 text-xs text-[#9a9aa2]">
            <LockKeyhole size={13} />
            企业内部系统 · 数据传输受保护
          </p>
        </div>
      </section>
    </main>
  );
}
