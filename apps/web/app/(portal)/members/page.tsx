"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  LoaderCircle,
  Plus,
  Power,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Badge, Button, Card, Field, inputClass } from "@/components/ui";
import { csrfToken } from "@/lib/content";

type Member = {
  id: string;
  email: string;
  name: string;
  role: "admin" | "operator";
  status: "active" | "disabled";
  mustChangePassword: boolean;
  createdAt: string;
};

export default function MembersPage() {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/users", {
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) throw new Error("成员列表读取失败");
    setMembers(((await response.json()) as { users: Member[] }).users);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load().catch((reason) => {
      setError(reason instanceof Error ? reason.message : "成员列表读取失败");
      setLoading(false);
    });
  }, [load]);

  async function createMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": await csrfToken(),
        },
        body: JSON.stringify({
          email: form.get("email"),
          name: form.get("name"),
          role: form.get("role"),
          temporaryPassword: form.get("temporaryPassword"),
        }),
      });
      const data = (await response.json()) as {
        error?: string;
        message?: string;
      };
      if (!response.ok)
        throw new Error(
          data.error === "CONFLICT"
            ? "该邮箱已经存在"
            : (data.message ?? "成员创建失败"),
        );
      formElement.reset();
      setNotice("成员已创建，首次登录必须修改临时密码");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "成员创建失败");
    } finally {
      setSaving(false);
    }
  }

  async function toggleMember(member: Member) {
    setTogglingId(member.id);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/admin/users/${member.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": await csrfToken(),
        },
        body: JSON.stringify({
          status: member.status === "active" ? "disabled" : "active",
        }),
      });
      const data = (await response.json()) as { message?: string };
      if (!response.ok) throw new Error(data.message ?? "成员状态更新失败");
      setNotice(member.status === "active" ? "成员已停用" : "成员已启用");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "成员状态更新失败");
    } finally {
      setTogglingId(null);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Access Control"
        title="成员管理"
        description="管理员创建成员与临时密码；成员首次登录必须修改密码。管理员与运营权限严格分离。"
      />
      {(notice || error) && (
        <div
          role={error ? "alert" : "status"}
          className={`mb-5 rounded-2xl border px-4 py-3 text-sm ${error ? "border-[#f6b8be] bg-[#fff1f2] text-[#b90012]" : "border-[#bde3cb] bg-[#edf8f1] text-[#187844]"}`}
        >
          {error || notice}
        </div>
      )}
      <div className="grid gap-5 xl:grid-cols-[1.35fr_.65fr]">
        <Card className="overflow-hidden">
          <div className="grid grid-cols-[1fr_110px_120px_112px] border-b border-[#ededf0] bg-[#fafafa] px-6 py-3 text-xs font-semibold text-[#85858e]">
            <span>成员</span>
            <span>角色</span>
            <span>状态</span>
            <span>操作</span>
          </div>
          {loading ? (
            <div className="px-6 py-8 text-sm text-[#85858e]">
              正在读取成员…
            </div>
          ) : (
            members.map((member) => (
              <div
                key={member.id}
                className="grid grid-cols-[1fr_110px_120px_112px] items-center border-b border-[#f0f0f2] px-6 py-5 last:border-0"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#17171a] text-white">
                    <UserRound size={18} />
                  </span>
                  <div className="min-w-0">
                    <strong className="block truncate text-sm">
                      {member.name}
                    </strong>
                    <span className="block truncate text-xs text-[#85858e]">
                      {member.email}
                    </span>
                  </div>
                </div>
                <span>
                  <Badge tone={member.role === "admin" ? "red" : "neutral"}>
                    {member.role === "admin" ? "管理员" : "运营"}
                  </Badge>
                </span>
                <span className="flex flex-col items-start gap-1">
                  <Badge
                    tone={member.status === "active" ? "green" : "neutral"}
                  >
                    {member.status === "active" ? "已启用" : "已停用"}
                  </Badge>
                  {member.mustChangePassword && (
                    <small className="text-[10px] text-[#a66a00]">
                      待改密码
                    </small>
                  )}
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={togglingId !== null}
                  onClick={() => toggleMember(member)}
                >
                  {togglingId === member.id ? (
                    <LoaderCircle size={14} className="animate-spin" />
                  ) : (
                    <Power size={14} />
                  )}
                  {togglingId === member.id
                    ? "更新中…"
                    : member.status === "active"
                      ? "停用"
                      : "启用"}
                </Button>
              </div>
            ))
          )}
        </Card>
        <Card className="h-fit p-6">
          <div className="flex items-center gap-2">
            <Plus size={18} className="text-[#e60012]" />
            <h2 className="font-bold">添加成员</h2>
          </div>
          <form onSubmit={createMember} className="mt-5 grid gap-4">
            <Field label="姓名">
              <input
                required
                name="name"
                maxLength={80}
                className={inputClass}
              />
            </Field>
            <Field label="工作邮箱">
              <input
                required
                name="email"
                type="email"
                className={inputClass}
              />
            </Field>
            <Field label="角色">
              <select
                name="role"
                defaultValue="operator"
                className={inputClass}
              >
                <option value="operator">运营成员</option>
                <option value="admin">管理员</option>
              </select>
            </Field>
            <Field label="临时密码" hint="至少 12 位，首次登录后必须修改">
              <input
                required
                name="temporaryPassword"
                type="password"
                minLength={12}
                autoComplete="new-password"
                className={inputClass}
              />
            </Field>
            <Button type="submit" disabled={saving}>
              {saving ? (
                <LoaderCircle size={15} className="animate-spin" />
              ) : (
                <Plus size={15} />
              )}
              {saving ? "正在创建…" : "创建成员"}
            </Button>
          </form>
        </Card>
      </div>
      <div className="mt-5 flex items-start gap-3 rounded-2xl border border-[#e6e6e9] bg-white p-5">
        <ShieldCheck size={20} className="mt-0.5 text-[#e60012]" />
        <p className="text-xs leading-5 text-[#666a73]">
          成员创建、停用、角色变更与密码重置都会写入审计日志。普通运营成员不能访问渠道配置、定时任务和成员管理接口。
        </p>
      </div>
    </>
  );
}
