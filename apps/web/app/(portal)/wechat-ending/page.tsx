"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ExternalLink, Save } from "lucide-react";
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

const emptyRecommendation = () => ({ title: "", url: "" });

export default function WechatEndingPage() {
  const [ending, setEnding] = useState<WechatEnding | null>(null);
  const [open, setOpen] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    void fetch("/api/settings/wechat-ending", {
      credentials: "include",
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("公众号结尾配置读取失败");
        return response.json() as Promise<{ ending?: WechatEnding }>;
      })
      .then((data) => {
        if (!data.ending) throw new Error("公众号结尾配置不存在");
        setEnding(data.ending);
      })
      .catch((reason: unknown) => {
        setError(true);
        setMessage(
          reason instanceof Error ? reason.message : "公众号结尾配置读取失败",
        );
      });
  }, []);

  function recommendationsWith(index: number) {
    return Array.from(
      { length: Math.max(ending?.recommendations.length ?? 0, index + 1) },
      (_, itemIndex) =>
        ending?.recommendations[itemIndex] ?? emptyRecommendation(),
    );
  }

  async function save() {
    if (!ending) return;
    setSaving(true);
    setError(false);
    setMessage("");
    try {
      const partiallyFilled = ending.recommendations.find(
        (item) => Boolean(item.title.trim()) !== Boolean(item.url.trim()),
      );
      if (partiallyFilled)
        throw new Error("精彩推荐的标题和链接需要同时填写，或同时留空");
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
      if (!response.ok) {
        if (response.status === 403)
          throw new Error(
            "当前账号可以查看，但只有管理员可以修改公众号默认结尾",
          );
        throw new Error("保存失败，请检查推荐链接是否为 HTTPS");
      }
      setEnding({ ...ending, recommendations });
      setMessage("已保存。此版本会自动附加到之后创建的公众号文章末尾");
    } catch (reason) {
      setError(true);
      setMessage(
        reason instanceof Error ? reason.message : "公众号结尾保存失败",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="WeChat Ending"
        title="公众号默认结尾"
        description="长期维护团队介绍、联系方式、主营业务和精彩推荐；创建公众号任务时自动保存当前版本并放在文章末尾。"
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Card className="overflow-hidden p-0">
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            className="focus-ring flex w-full items-center justify-between gap-4 px-6 py-5 text-left"
            aria-expanded={open}
          >
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-bold">编辑默认结尾</h2>
                <Badge tone="red">自动追加</Badge>
              </div>
              <p className="mt-1 text-xs leading-5 text-[#85858e]">
                点击收起或展开；精彩推荐固定提供 3 个可选位置
              </p>
            </div>
            <ChevronDown
              size={18}
              className={`shrink-0 transition ${open ? "rotate-180" : ""}`}
            />
          </button>
          {open && (
            <div className="border-t border-[#ededf0] px-6 py-5">
              {!ending ? (
                <p className="text-sm text-[#85858e]">
                  {message || "正在读取配置…"}
                </p>
              ) : (
                <div className="grid gap-5">
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
                        setEnding({
                          ...ending,
                          about: event.currentTarget.value,
                        })
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
                  <section>
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold">精彩推荐</h3>
                      <ExternalLink size={15} className="text-[#e60012]" />
                    </div>
                    <p className="mt-1 text-xs text-[#85858e]">
                      最多 3 篇过往公众号文章；标题与 HTTPS
                      链接成对填写，也可以留空。
                    </p>
                    <div className="mt-3 grid gap-3">
                      {Array.from(
                        { length: 3 },
                        (_, index) =>
                          ending.recommendations[index] ??
                          emptyRecommendation(),
                      ).map((item, index) => (
                        <div
                          key={index}
                          className="grid gap-2 rounded-2xl border border-[#ededf0] bg-[#fafafa] p-3 sm:grid-cols-[minmax(0,.8fr)_minmax(0,1.2fr)]"
                        >
                          <input
                            aria-label={`推荐 ${index + 1} 标题`}
                            className={inputClass}
                            placeholder={`推荐 ${index + 1} 标题`}
                            value={item.title}
                            onChange={(event) => {
                              const next = recommendationsWith(index);
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
                              const next = recommendationsWith(index);
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
                  </section>
                  {message && (
                    <p
                      role={error ? "alert" : "status"}
                      className={`rounded-xl border px-3.5 py-3 text-sm ${error ? "border-[#f6b8be] bg-[#fff1f2] text-[#b90012]" : "border-[#bde3cb] bg-[#edf8f1] text-[#187844]"}`}
                    >
                      {message}
                    </p>
                  )}
                  <Button
                    type="button"
                    className="w-fit"
                    disabled={saving}
                    onClick={() => void save()}
                  >
                    <Save size={16} />
                    {saving ? "正在保存…" : "保存公众号默认结尾"}
                  </Button>
                </div>
              )}
            </div>
          )}
        </Card>
        <div className="space-y-5">
          <Card className="p-5">
            <h2 className="text-sm font-bold">生效规则</h2>
            <ul className="mt-3 space-y-2 text-xs leading-5 text-[#666a73]">
              <li>新建公众号任务时保存当前结尾快照。</li>
              <li>默认放在总结之后、文章最末尾。</li>
              <li>修改不会追溯改变历史任务和既有草稿。</li>
              <li>精彩推荐为空时不会生成空链接。</li>
            </ul>
          </Card>
          <Card className="border-[#f3c4c8] bg-[#fffafa] p-5">
            <h2 className="text-sm font-bold text-[#b90012]">发布边界</h2>
            <p className="mt-2 text-xs leading-5 text-[#7a5559]">
              这里只管理公众号草稿的默认结尾，不会触发群发或正式发布。
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}
