"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, KeyRound, Lock, Save, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Badge, Button, Card, Field, inputClass } from "@/components/ui";
import { csrfToken } from "@/lib/content";

type WechatEnding = {
  about: string;
  slogan: string;
  phone: string;
  website: string;
  address: string;
  services: string[];
  recommendations: Array<{ title: string; url: string }>;
};

export default function SettingsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const mustChange = params.get("changePassword") === "1";
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [endingOpen, setEndingOpen] = useState(false);
  const [ending, setEnding] = useState<WechatEnding | null>(null);
  const [endingSaving, setEndingSaving] = useState(false);
  const [endingMessage, setEndingMessage] = useState("");

  useEffect(() => {
    void fetch("/api/settings/wechat-ending", {
      credentials: "include",
      cache: "no-store",
    })
      .then((response) => response.json())
      .then((data: { ending?: WechatEnding }) => {
        if (data.ending) setEnding(data.ending);
      })
      .catch(() => setEndingMessage("公众号结尾配置读取失败"));
  }, []);

  async function saveWechatEnding() {
    if (!ending) return;
    setEndingSaving(true);
    setEndingMessage("");
    try {
      const recommendations = ending.recommendations.filter(
        (item) => item.title.trim() && item.url.trim(),
      );
      const response = await fetch("/api/settings/wechat-ending", {
        method: "PUT",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": await csrfToken(),
        },
        body: JSON.stringify({ ...ending, recommendations }),
      });
      if (!response.ok)
        throw new Error("公众号结尾保存失败，请检查推荐链接是否为 HTTPS");
      setEnding({ ...ending, recommendations });
      setEndingMessage("公众号结尾已保存，新建任务将使用此版本");
    } catch (reason) {
      setEndingMessage(
        reason instanceof Error ? reason.message : "公众号结尾保存失败",
      );
    } finally {
      setEndingSaving(false);
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setError("");
    setSuccess("");
    const form = new FormData(formElement);
    const currentPassword = String(form.get("currentPassword") ?? "");
    const newPassword = String(form.get("newPassword") ?? "");
    const confirmPassword = String(form.get("confirmPassword") ?? "");
    if (newPassword.length < 12) return setError("新密码至少需要 12 位");
    if (newPassword !== confirmPassword)
      return setError("两次输入的新密码不一致");
    if (currentPassword === newPassword)
      return setError("新密码不能与当前密码相同");

    setLoading(true);
    try {
      const { csrfToken } = (await fetch("/api/auth/csrf").then((response) =>
        response.json(),
      )) as { csrfToken: string };
      const response = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = (await response.json()) as { message?: string };
      if (!response.ok)
        throw new Error(data.message ?? "密码修改失败，请检查当前密码");
      formElement.reset();
      setSuccess("密码已更新，正在进入工作台…");
      router.replace("/dashboard");
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "密码修改失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="System Settings"
        title="系统设置"
        description="管理模型、品牌规则和账号安全。敏感配置只通过服务器环境变量注入，不在数据库保存明文。"
      />
      <div className="grid gap-5 xl:grid-cols-[1.3fr_.8fr]">
        <div className="space-y-5">
          {mustChange && (
            <div className="flex gap-3 rounded-2xl border border-[#f6b8be] bg-[#fff1f2] p-5">
              <KeyRound size={20} className="mt-0.5 shrink-0 text-[#e60012]" />
              <div>
                <strong className="text-sm text-[#b90012]">
                  首次登录必须修改临时密码
                </strong>
                <p className="mt-1 text-xs leading-5 text-[#8b454c]">
                  完成修改后才能进入其他功能页面。
                </p>
              </div>
            </div>
          )}
          <Card className="p-6">
            <div className="flex items-center gap-2">
              <Lock size={18} className="text-[#e60012]" />
              <h2 className="font-bold">修改密码</h2>
            </div>
            <form onSubmit={changePassword} className="mt-5 grid gap-4">
              <Field label="当前密码">
                <input
                  required
                  name="currentPassword"
                  autoComplete="current-password"
                  type="password"
                  className={inputClass}
                />
              </Field>
              <Field
                label="新密码"
                hint="至少 12 位，建议包含大小写字母、数字和符号"
              >
                <input
                  required
                  name="newPassword"
                  autoComplete="new-password"
                  minLength={12}
                  type="password"
                  className={inputClass}
                />
              </Field>
              <Field label="确认新密码">
                <input
                  required
                  name="confirmPassword"
                  autoComplete="new-password"
                  minLength={12}
                  type="password"
                  className={inputClass}
                />
              </Field>
              {error && (
                <div
                  role="alert"
                  className="rounded-xl border border-[#f6b8be] bg-[#fff1f2] px-3.5 py-3 text-sm text-[#b90012]"
                >
                  {error}
                </div>
              )}
              {success && (
                <div
                  role="status"
                  className="rounded-xl border border-[#bde3cb] bg-[#edf8f1] px-3.5 py-3 text-sm text-[#187844]"
                >
                  {success}
                </div>
              )}
              <Button disabled={loading} className="w-fit" type="submit">
                <Save size={16} />
                {loading ? "正在保存…" : "保存新密码"}
              </Button>
            </form>
          </Card>
          <Card className="overflow-hidden p-0">
            <button
              type="button"
              onClick={() => setEndingOpen((current) => !current)}
              className="focus-ring flex w-full items-center justify-between gap-4 px-6 py-5 text-left"
              aria-expanded={endingOpen}
            >
              <div>
                <h2 className="font-bold">公众号结尾管理</h2>
                <p className="mt-1 text-xs text-[#85858e]">
                  默认附加到新文章末尾，可长期维护公司信息与精彩推荐
                </p>
              </div>
              <ChevronDown
                size={18}
                className={`shrink-0 transition ${endingOpen ? "rotate-180" : ""}`}
              />
            </button>
            {endingOpen && ending && (
              <div className="grid gap-4 border-t border-[#ededf0] px-6 py-5">
                <Field label="团队口号">
                  <input
                    className={inputClass}
                    value={ending.slogan}
                    onChange={(event) =>
                      setEnding({
                        ...ending,
                        slogan: event.currentTarget.value,
                      })
                    }
                  />
                </Field>
                <Field label="关于我们">
                  <textarea
                    className={`${inputClass} min-h-28 resize-y py-3`}
                    value={ending.about}
                    onChange={(event) =>
                      setEnding({ ...ending, about: event.currentTarget.value })
                    }
                  />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="联系电话">
                    <input
                      className={inputClass}
                      value={ending.phone}
                      onChange={(event) =>
                        setEnding({
                          ...ending,
                          phone: event.currentTarget.value,
                        })
                      }
                    />
                  </Field>
                  <Field label="官网">
                    <input
                      className={inputClass}
                      value={ending.website}
                      onChange={(event) =>
                        setEnding({
                          ...ending,
                          website: event.currentTarget.value,
                        })
                      }
                    />
                  </Field>
                </div>
                <Field label="公司地址">
                  <input
                    className={inputClass}
                    value={ending.address}
                    onChange={(event) =>
                      setEnding({
                        ...ending,
                        address: event.currentTarget.value,
                      })
                    }
                  />
                </Field>
                <Field label="主营业务" hint="每行一项，最多 6 项">
                  <textarea
                    className={`${inputClass} min-h-24 resize-y py-3`}
                    value={ending.services.join("\n")}
                    onChange={(event) =>
                      setEnding({
                        ...ending,
                        services: event.currentTarget.value
                          .split("\n")
                          .map((item) => item.trim())
                          .filter(Boolean)
                          .slice(0, 6),
                      })
                    }
                  />
                </Field>
                <div>
                  <div className="mb-2 text-sm font-semibold">精彩推荐</div>
                  <p className="mb-3 text-xs text-[#85858e]">
                    可留空；最多 3 篇，链接必须使用 HTTPS
                  </p>
                  <div className="grid gap-3">
                    {Array.from(
                      { length: 3 },
                      (_, index) =>
                        ending.recommendations[index] ?? { title: "", url: "" },
                    ).map((item, index) => (
                      <div
                        key={index}
                        className="grid gap-2 rounded-xl border border-[#ededf0] bg-[#fafafa] p-3 sm:grid-cols-[.8fr_1.2fr]"
                      >
                        <input
                          aria-label={`推荐 ${index + 1} 标题`}
                          className={inputClass}
                          placeholder="文章标题"
                          value={item.title}
                          onChange={(event) => {
                            const next = Array.from(
                              {
                                length: Math.max(
                                  ending.recommendations.length,
                                  index + 1,
                                ),
                              },
                              (_, itemIndex) =>
                                ending.recommendations[itemIndex] ?? {
                                  title: "",
                                  url: "",
                                },
                            );
                            next[index] = {
                              ...item,
                              title: event.currentTarget.value,
                            };
                            setEnding({ ...ending, recommendations: next });
                          }}
                        />
                        <input
                          aria-label={`推荐 ${index + 1} 链接`}
                          className={inputClass}
                          placeholder="https://mp.weixin.qq.com/..."
                          value={item.url}
                          onChange={(event) => {
                            const next = Array.from(
                              {
                                length: Math.max(
                                  ending.recommendations.length,
                                  index + 1,
                                ),
                              },
                              (_, itemIndex) =>
                                ending.recommendations[itemIndex] ?? {
                                  title: "",
                                  url: "",
                                },
                            );
                            next[index] = {
                              ...item,
                              url: event.currentTarget.value,
                            };
                            setEnding({ ...ending, recommendations: next });
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
                {endingMessage && (
                  <p role="status" className="text-sm text-[#55555d]">
                    {endingMessage}
                  </p>
                )}
                <Button
                  type="button"
                  className="w-fit"
                  disabled={endingSaving}
                  onClick={() => void saveWechatEnding()}
                >
                  <Save size={16} />
                  {endingSaving ? "正在保存…" : "保存公众号结尾"}
                </Button>
              </div>
            )}
          </Card>
          <Card className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-bold">AI 模型</h2>
                <p className="mt-1 text-xs text-[#85858e]">
                  生产模型由服务器环境变量统一管理，普通成员不能修改
                </p>
              </div>
              <Badge>管理员</Badge>
            </div>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <Field label="文本模型">
                <input
                  className={`${inputClass} bg-[#f5f5f6]`}
                  disabled
                  value="gpt-5.6-sol"
                  readOnly
                />
              </Field>
              <Field label="图片模型">
                <input
                  className={`${inputClass} bg-[#f5f5f6]`}
                  disabled
                  value="gpt-image-2"
                  readOnly
                />
              </Field>
            </div>
          </Card>
        </div>
        <Card className="h-fit p-6">
          <div className="flex items-center gap-2">
            <ShieldCheck size={19} className="text-[#e60012]" />
            <h2 className="font-bold">安全基线</h2>
          </div>
          <ul className="mt-5 space-y-3 text-sm text-[#666a73]">
            {[
              "Argon2id 密码哈希",
              "HttpOnly 严格会话 Cookie",
              "CSRF 双重提交校验",
              "登录失败自动锁定",
              "管理员与运营两级权限",
              "关键操作审计留痕",
            ].map((item) => (
              <li key={item} className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-[#e60012]" />
                {item}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
