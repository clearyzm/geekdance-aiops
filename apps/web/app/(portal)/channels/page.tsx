"use client";

import { useCallback, useEffect, useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  Cloud,
  Download,
  Globe2,
  Laptop,
  MessageCircleMore,
  PlugZap,
  Radio,
  RefreshCw,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { useUser } from "@/components/auth-guard";
import { Badge, Button, Card } from "@/components/ui";
import { csrfToken } from "@/lib/content";

const REQUIRED_XHS_EXTENSION_VERSION = "1.4.0";
const browserChannelIds = new Set([
  "xiaohongshu",
  "zhihu",
  "toutiao",
  "baijiahao",
  "linkedin",
]);
const channelNames: Record<string, string> = {
  xiaohongshu: "小红书",
  zhihu: "知乎文章",
  toutiao: "今日头条",
  baijiahao: "百家号",
  linkedin: "LinkedIn",
};
const icons = {
  official_site: Globe2,
  wechat: MessageCircleMore,
  xiaohongshu: BookOpen,
  zhihu: BookOpen,
  toutiao: BookOpen,
  baijiahao: BookOpen,
  linkedin: BookOpen,
  openrouter: Radio,
  oss: Cloud,
};
type Channel = {
  id: keyof typeof icons;
  name: string;
  status: string;
  textModel?: string;
  imageModel?: string;
  contentMode?: string;
  imageMode?: string;
  storageMode?: "oss_and_local" | "local_volume";
  issues?: Array<{ code: string; message: string }>;
};
type ExtensionToken = {
  id: string;
  name: string;
  lastUsedAt?: string | null;
  expiresAt: string;
  revokedAt?: string | null;
};
type LocalExtension = {
  detected: boolean;
  configured: boolean;
  connected: boolean;
  connectionUnavailable?: boolean;
  outdated?: boolean;
  version?: string;
};
type ChannelAccount = {
  id: string;
  channel: string;
  displayName: string;
  status: "active" | "disabled";
  online: boolean;
  owner: { id: string; name: string };
  deviceName: string;
  lastSeenAt: string;
};

const statusText: Record<string, string> = {
  live: "已连接",
  mock: "未启用",
  not_configured: "待配置",
  coming_soon: "即将上线",
  healthy: "正常",
  degraded: "需检查",
};

function isExtensionVersionAtLeast(current: string, required: string) {
  const currentParts = current
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  const requiredParts = required
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  if (
    currentParts.some((part) => !Number.isFinite(part)) ||
    requiredParts.some((part) => !Number.isFinite(part))
  )
    return false;
  const length = Math.max(currentParts.length, requiredParts.length);
  for (let index = 0; index < length; index += 1) {
    const currentPart = currentParts[index] || 0;
    const requiredPart = requiredParts[index] || 0;
    if (currentPart > requiredPart) return true;
    if (currentPart < requiredPart) return false;
  }
  return true;
}

function waitForWebsiteMessage(
  requestId: string,
  type: string,
  timeout = 6000,
) {
  return new Promise<Record<string, any>>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", receive);
      reject(new Error("未检测到多平台草稿助手"));
    }, timeout);
    function receive(event: MessageEvent) {
      if (
        event.source !== window ||
        event.origin !== window.location.origin ||
        event.data?.type !== type ||
        event.data?.requestId !== requestId
      )
        return;
      window.clearTimeout(timer);
      window.removeEventListener("message", receive);
      resolve(event.data);
    }
    window.addEventListener("message", receive);
  });
}

async function pingExtension(attempts = 3) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const requestId = crypto.randomUUID();
      const response = waitForWebsiteMessage(requestId, "GD_XHS_PONG", 1800);
      window.postMessage(
        { type: "GD_XHS_PING", requestId },
        window.location.origin,
      );
      return await response;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts)
        await new Promise((resolve) => window.setTimeout(resolve, 350));
    }
  }
  throw lastError;
}

async function checkExtensionConnection() {
  const requestId = crypto.randomUUID();
  const response = waitForWebsiteMessage(
    requestId,
    "GD_XHS_CONNECTION_RESULT",
    6000,
  );
  window.postMessage(
    { type: "GD_XHS_CHECK_CONNECTION", requestId },
    window.location.origin,
  );
  return response;
}

export default function ChannelsPage() {
  const user = useUser();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [tokens, setTokens] = useState<ExtensionToken[]>([]);
  const [accounts, setAccounts] = useState<ChannelAccount[]>([]);
  const [localExtension, setLocalExtension] = useState<LocalExtension>({
    detected: false,
    configured: false,
    connected: false,
  });
  const [checking, setChecking] = useState(true);
  const [pairing, setPairing] = useState(false);
  const [bindingChannel, setBindingChannel] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [healthResponse, tokenResponse, accountResponse] = await Promise.all([
      fetch("/api/admin/channel-health", {
        credentials: "include",
        cache: "no-store",
      }),
      fetch("/api/extension-tokens", {
        credentials: "include",
        cache: "no-store",
      }),
      fetch("/api/channel-accounts", {
        credentials: "include",
        cache: "no-store",
      }),
    ]);
    if (healthResponse.ok)
      setChannels(
        ((await healthResponse.json()) as { channels: Channel[] }).channels,
      );
    if (tokenResponse.ok)
      setTokens(
        ((await tokenResponse.json()) as { tokens: ExtensionToken[] }).tokens,
      );
    if (accountResponse.ok)
      setAccounts(
        ((await accountResponse.json()) as { accounts: ChannelAccount[] })
          .accounts,
      );
  }, []);

  const detectExtension = useCallback(async () => {
    setChecking(true);
    try {
      const result = await pingExtension();
      const base = {
        detected: true,
        configured: result.configured === true,
        connected: false,
        version: String(result.version || ""),
      };
      if (
        !isExtensionVersionAtLeast(base.version, REQUIRED_XHS_EXTENSION_VERSION)
      ) {
        setLocalExtension({ ...base, outdated: true });
        setError("助手版本过旧，请下载最新版并覆盖原扩展目录。");
        return;
      }
      if (!base.configured) {
        setLocalExtension(base);
        setError("");
        return;
      }
      try {
        const connection = await checkExtensionConnection();
        const connectionResult = connection.result as
          | {
              ok?: boolean;
              reconnectRequired?: boolean;
              error?: string;
            }
          | undefined;
        setLocalExtension({
          ...base,
          connected: connectionResult?.ok === true,
        });
        setError(
          connectionResult?.ok === true
            ? ""
            : connectionResult?.reconnectRequired === true
              ? "这台电脑的连接已过期，点击“立即启用”即可恢复。"
              : connectionResult?.error || "连接检查失败，请稍后重试。",
        );
      } catch {
        setLocalExtension({
          ...base,
          connectionUnavailable: true,
        });
        setError("扩展已安装，但暂时无法检查连接，请确认网络正常后再试。");
      }
    } catch {
      setLocalExtension({
        detected: false,
        configured: false,
        connected: false,
      });
      setError(
        "当前标签页未检测到助手。若扩展已启用，请重新加载扩展后点击“重新检查”。",
      );
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void load().catch(() => setError("渠道状态读取失败"));
    void detectExtension();
  }, [detectExtension, load]);

  useEffect(() => {
    const handleFocus = () => void detectExtension();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [detectExtension]);

  async function pairThisComputer() {
    setPairing(true);
    setError("");
    setMessage("");
    let tokenId = "";
    try {
      const current = await pingExtension();
      if (!current) throw new Error("请先安装多平台草稿助手并刷新本页");
      const response = await fetch("/api/extension-tokens", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": await csrfToken(),
        },
        body: JSON.stringify({
          name: `${user?.name || "运营成员"} · ${navigator.platform || "Chrome"}`,
        }),
      });
      const data = (await response.json()) as {
        token?: { id: string; token: string };
        message?: string;
      };
      if (!response.ok || !data.token)
        throw new Error(data.message || "个人连接创建失败");
      tokenId = data.token.id;
      const requestId = crypto.randomUUID();
      const paired = waitForWebsiteMessage(
        requestId,
        "GD_XHS_PAIR_RESULT",
        8000,
      );
      window.postMessage(
        {
          type: "GD_XHS_PAIR",
          requestId,
          token: data.token.token,
          deviceName: navigator.platform || "Chrome",
        },
        window.location.origin,
      );
      const pairResult = await paired;
      if (!pairResult.result?.ok)
        throw new Error(pairResult.result?.error || "扩展连接检查失败");
      setMessage("这台电脑已连接。以后可直接从任务详情保存五个平台的草稿。");
      await Promise.all([load(), detectExtension()]);
    } catch (reason) {
      if (tokenId)
        await fetch(`/api/extension-tokens/${tokenId}`, {
          method: "DELETE",
          credentials: "include",
          headers: { "x-csrf-token": await csrfToken() },
        }).catch(() => undefined);
      setError(reason instanceof Error ? reason.message : "连接失败");
    } finally {
      setPairing(false);
    }
  }

  async function revokeToken(tokenId: string) {
    const response = await fetch(`/api/extension-tokens/${tokenId}`, {
      method: "DELETE",
      credentials: "include",
      headers: { "x-csrf-token": await csrfToken() },
    });
    if (!response.ok) return setError("连接撤销失败");
    await load();
  }

  async function bindAccount(channel: string) {
    setBindingChannel(channel);
    setError("");
    setMessage("");
    try {
      if (!localExtension.connected)
        throw new Error("请先启用当前电脑的多平台助手");
      const requestId = crypto.randomUUID();
      const response = waitForWebsiteMessage(
        requestId,
        "GD_BIND_CHANNEL_ACCOUNT_RESULT",
        40_000,
      );
      window.postMessage(
        { type: "GD_BIND_CHANNEL_ACCOUNT", requestId, channel },
        window.location.origin,
      );
      const result = await response;
      if (!result.result?.ok)
        throw new Error(result.result?.error || "账号绑定失败");
      setMessage(
        `${channelNames[channel] || channel}账号已绑定，可在“多账号发布”中选择。`,
      );
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "账号绑定失败");
    } finally {
      setBindingChannel("");
    }
  }

  const active = channels.filter((channel) => channel.id in icons);
  const personalTokens = tokens.filter(
    (token) => !token.revokedAt && new Date(token.expiresAt) > new Date(),
  );

  return (
    <>
      <PageHeader
        eyebrow="Channel Management"
        title="渠道管理"
        description="查看渠道状态。多平台助手安装一次后，可复用当前浏览器中已登录的小红书、知乎、今日头条、百家号和 LinkedIn 账号。"
      />

      <Card className="mb-5 overflow-hidden border-[#f3c6ca] bg-white">
        <div className="grid gap-6 p-6 lg:grid-cols-[1.2fr_.8fr]">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#fff1f2] text-[#e60012]">
                <Laptop size={20} />
              </span>
              <div>
                <h2 className="font-bold">当前电脑 · 多平台草稿助手</h2>
                <p className="mt-1 text-xs text-[#73737c]">
                  使用这台电脑当前登录的五个平台账号填写草稿或执行受控发布，不共享密码、Cookie
                  或登录状态。
                </p>
              </div>
              <Badge
                tone={
                  localExtension.detected && localExtension.connected
                    ? "green"
                    : "amber"
                }
              >
                {checking
                  ? "正在检测"
                  : !localExtension.detected
                    ? "未安装"
                    : localExtension.outdated
                      ? "需更新"
                      : localExtension.connected
                        ? "已连接"
                        : localExtension.connectionUnavailable
                          ? "连接待检查"
                          : "待连接"}
              </Badge>
            </div>
            <div className="mt-5 flex flex-wrap gap-3">
              {!localExtension.detected || localExtension.outdated ? (
                <a
                  href={
                    localExtension.outdated
                      ? "/downloads/geekdance-xiaohongshu-draft-uploader.zip"
                      : "/downloads/geekdance-multi-platform-draft-uploader.zip"
                  }
                  download
                  className="focus-ring inline-flex h-11 items-center gap-2 rounded-xl bg-[#17171a] px-4 text-sm font-semibold text-white hover:bg-[#e60012]"
                >
                  <Download size={16} />
                  {localExtension.outdated
                    ? "下载兼容更新包"
                    : "下载多平台助手"}
                </a>
              ) : !localExtension.connected &&
                !localExtension.connectionUnavailable ? (
                <Button
                  onClick={() => void pairThisComputer()}
                  disabled={pairing}
                >
                  <PlugZap size={16} />
                  {pairing ? "正在启用…" : "立即启用"}
                </Button>
              ) : (
                <span className="inline-flex h-11 items-center gap-2 rounded-xl bg-[#edf8f1] px-4 text-sm font-semibold text-[#187844]">
                  <CheckCircle2 size={16} />
                  已准备就绪
                </span>
              )}
              <Button
                variant="secondary"
                onClick={() => void detectExtension()}
                disabled={checking}
              >
                <RefreshCw size={16} />
                重新检查
              </Button>
            </div>
            {!localExtension.detected && (
              <ol className="mt-4 list-decimal space-y-1 pl-5 text-xs leading-5 text-[#666a73]">
                <li>下载并解压安装包。</li>
                <li>在 Chrome 扩展管理页加载解压后的文件夹。</li>
                <li>登录需要使用的小红书、知乎、今日头条、百家号或 LinkedIn 创作后台。</li>
                <li>
                  回到任务详情点击对应平台的“保存到草稿箱”，系统会自动完成后续设置。
                </li>
              </ol>
            )}
            {message && (
              <p className="mt-4 rounded-xl bg-[#edf8f1] p-3 text-xs text-[#187844]">
                {message}
              </p>
            )}
            {error && (
              <p
                role="alert"
                className="mt-4 rounded-xl bg-[#fff1f2] p-3 text-xs text-[#b90012]"
              >
                {error}
              </p>
            )}
          </div>
          <div className="rounded-2xl bg-[#f7f7f8] p-4">
            <div className="flex items-center gap-2 text-sm font-bold">
              <ShieldCheck size={17} className="text-[#e60012]" />
              草稿安全边界
            </div>
            <ul className="mt-3 space-y-2 text-xs leading-5 text-[#666a73]">
              <li>不读取或上传任何平台密码、Cookie。</li>
              <li>只领取当前运营中心中的指定任务。</li>
              <li>
                草稿模式只点击明确的草稿按钮；正式发布必须在运营中心单次授权。
              </li>
              <li>遇到验证码、页面变化或结果不明确时立即停止。</li>
            </ul>
            {localExtension.version && (
              <p className="mt-3 text-[11px] text-[#85858e]">助手已安装</p>
            )}
          </div>
        </div>
        {personalTokens.length > 0 && (
          <div className="border-t border-[#ededf0] px-6 py-4">
            <p className="text-xs font-bold">已启用的电脑</p>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {personalTokens.map((token) => (
                <div
                  key={token.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-[#ededf0] px-3 py-2 text-xs"
                >
                  <span className="min-w-0">
                    <strong className="block truncate">{token.name}</strong>
                    <span className="text-[11px] text-[#85858e]">
                      {token.lastUsedAt
                        ? `最近连接 ${new Date(token.lastUsedAt).toLocaleString("zh-CN", { hour12: false })}`
                        : "等待首次使用"}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => void revokeToken(token.id)}
                    className="shrink-0 font-semibold text-[#b90012] hover:underline"
                  >
                    停用
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {active.map((channel) => {
          const Icon = icons[channel.id as keyof typeof icons];
          const isBrowserChannel = browserChannelIds.has(channel.id);
          const runtimeIssues = (channel.issues ?? []).filter(
            (issue) => issue.code !== "BROWSER_EXTENSION_NOT_CONNECTED",
          );
          const backendReady =
            channel.status === "live" ||
            channel.status === "healthy" ||
            (isBrowserChannel && runtimeIssues.length === 0);
          const localBrowserReady =
            !checking &&
            localExtension.detected &&
            localExtension.connected &&
            !localExtension.outdated;
          const ready =
            backendReady && (!isBrowserChannel || localBrowserReady);
          const displayStatus = isBrowserChannel
            ? checking
              ? "正在检测"
              : !localExtension.detected
                ? "当前电脑未安装"
                : localExtension.outdated
                  ? "需更新"
                  : !backendReady
                    ? (statusText[channel.status] ?? channel.status)
                    : localExtension.connected
                      ? "已连接"
                      : localExtension.connectionUnavailable
                        ? "连接待检查"
                        : "当前电脑待连接"
            : (statusText[channel.status] ?? channel.status);
          return (
            <Card key={channel.id} className="p-6">
              <div className="flex items-start justify-between">
                <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#f5f5f6]">
                  <Icon size={20} />
                </span>
                <Badge tone={ready ? "green" : "neutral"}>
                  {displayStatus}
                </Badge>
              </div>
              <h2 className="mt-6 font-bold">{channel.name}</h2>
              <p className="mt-2 text-sm text-[#666a73]">
                {channel.id === "official_site"
                  ? "文章草稿与官网媒体上传，只提供草稿能力"
                  : channel.id === "wechat"
                    ? "公众号草稿与永久素材接口"
                    : ["xiaohongshu", "zhihu", "toutiao", "baijiahao", "linkedin"].includes(
                          channel.id,
                        )
                      ? "使用当前电脑已登录的平台账号填写草稿；正式发布需运营中心单次授权"
                      : channel.id === "oss"
                        ? channel.storageMode === "oss_and_local"
                          ? "公司 OSS 与 Docker 持久卷双重素材存储"
                          : "Docker 持久卷素材存储"
                        : "事实检索、文章写作与图片模型"}
              </p>
              {isBrowserChannel && (
                <Button
                  variant="secondary"
                  className="mt-4 w-full"
                  disabled={!localBrowserReady || Boolean(bindingChannel)}
                  onClick={() => void bindAccount(channel.id)}
                >
                  <PlugZap size={16} />
                  {bindingChannel === channel.id
                    ? "正在打开平台并识别账号…"
                    : "绑定当前登录账号"}
                </Button>
              )}
              {channel.id === "openrouter" &&
                (channel.textModel || channel.imageModel) && (
                  <div className="mt-4 space-y-1 rounded-xl bg-[#f7f7f8] px-3 py-2 text-xs text-[#666a73]">
                    <p>文本模型：{channel.textModel ?? "未配置"}</p>
                    <p>图片模型：{channel.imageModel ?? "未配置"}</p>
                  </div>
                )}
              {runtimeIssues.length > 0 && (
                <div className="mt-4 rounded-xl border border-[#f3d48d] bg-[#fff9e9] px-3 py-2 text-xs leading-5 text-[#76520b]">
                  {runtimeIssues.map((issue) => (
                    <p key={issue.code}>{issue.message}</p>
                  ))}
                </div>
              )}
              <div className="mt-5 flex items-center gap-2 border-t border-[#ededf0] pt-4 text-xs text-[#92929a]">
                {ready ? <CheckCircle2 size={14} /> : <Settings2 size={14} />}
                {user?.role === "admin"
                  ? "系统配置由管理员维护 · 密钥不会回显"
                  : "系统配置由管理员维护"}
              </div>
            </Card>
          );
        })}
      </div>
      <Card className="mt-5 p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-bold">团队平台账号</h2>
            <p className="mt-1 text-xs text-[#85858e]">
              这里只保存公开账号名称和连接状态，不保存密码、Cookie 或验证码。
            </p>
          </div>
          <Badge
            tone={
              accounts.some((account) => account.status === "active")
                ? "green"
                : "neutral"
            }
          >
            {accounts.filter((account) => account.status === "active").length}{" "}
            个可用
          </Badge>
        </div>
        <div className="mt-5 grid gap-3 md:grid-cols-2">
          {accounts.length === 0 ? (
            <div className="col-span-full rounded-2xl border border-dashed border-[#d8d8de] p-8 text-center text-sm text-[#85858e]">
              暂无已绑定账号，请在上方对应渠道点击“绑定当前登录账号”
            </div>
          ) : (
            accounts.map((account) => (
              <div
                key={account.id}
                className="flex items-center gap-3 rounded-2xl border border-[#e7e7ea] p-4"
              >
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-[#f5f5f6] text-sm font-bold">
                  {account.displayName.slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-sm">
                    {account.displayName}
                  </strong>
                  <span className="mt-1 block truncate text-xs text-[#85858e]">
                    {channelNames[account.channel] || account.channel} ·{" "}
                    {account.owner.name} · {account.deviceName}
                  </span>
                </span>
                <Badge
                  tone={
                    account.status === "active" && account.online
                      ? "green"
                      : "neutral"
                  }
                >
                  {account.status !== "active"
                    ? "已停用"
                    : account.online
                      ? "在线"
                      : "离线待连接"}
                </Badge>
              </div>
            ))
          )}
        </div>
      </Card>
    </>
  );
}
