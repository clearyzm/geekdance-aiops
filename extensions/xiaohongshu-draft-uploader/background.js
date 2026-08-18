const CREATOR_URLS = {
  xiaohongshu: "https://creator.xiaohongshu.com/publish/publish",
  zhihu: "https://zhuanlan.zhihu.com/write",
  toutiao: "https://mp.toutiao.com/profile_v4/graphic/publish",
  baijiahao: "https://baijiahao.baidu.com/builder/rc/edit?type=news",
  linkedin: "https://www.linkedin.com/article/new/",
};
const CHANNEL_NAMES = {
  xiaohongshu: "小红书",
  zhihu: "知乎文章",
  toutiao: "今日头条",
  baijiahao: "百家号",
  linkedin: "LinkedIn",
};
const ALLOWED_API_BASE_URLS = new Set([
  "https://aiops.geekdance.cn",
  "http://127.0.0.1:4000",
  "http://localhost:4000",
]);
const pendingContentResults = new Map();
let deliveryPollRunning = false;
const OPERATIONS_CENTER_URL_PATTERNS = [
  "https://aiops.geekdance.cn/*",
  "http://127.0.0.1/*",
  "http://localhost/*",
];

function isOperationsCenterUrl(url = "") {
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === "https://aiops.geekdance.cn" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost"
    );
  } catch {
    return false;
  }
}

async function injectWebsiteBridge(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["website-bridge.js"],
    });
  } catch {
    // The tab can disappear or deny injection while Chrome restores a session.
  }
}

async function restoreWebsiteBridges() {
  const tabs = await chrome.tabs.query({ url: OPERATIONS_CENTER_URL_PATTERNS });
  await Promise.all(
    tabs
      .filter((tab) => tab.id && isOperationsCenterUrl(tab.url))
      .map((tab) => injectWebsiteBridge(tab.id)),
  );
}

void restoreWebsiteBridges();
chrome.runtime.onInstalled.addListener(() => void restoreWebsiteBridges());
chrome.runtime.onStartup.addListener(() => void restoreWebsiteBridges());
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && isOperationsCenterUrl(tab.url))
    void injectWebsiteBridge(tabId);
});

function waitForContentResult(taskId, timeoutMs = 150_000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingContentResults.delete(taskId);
      resolve(null);
    }, timeoutMs);
    pendingContentResults.set(taskId, (result) => {
      clearTimeout(timer);
      pendingContentResults.delete(taskId);
      resolve(result);
    });
  });
}

async function settings() {
  const value = await chrome.storage.local.get(["apiBaseUrl", "token"]);
  const apiBaseUrl = (value.apiBaseUrl || "https://aiops.geekdance.cn").replace(
    /\/$/,
    "",
  );
  if (!ALLOWED_API_BASE_URLS.has(apiBaseUrl))
    throw new Error("运营中心地址不在安全白名单中");
  return {
    apiBaseUrl,
    token: value.token || "",
  };
}

async function localStatus() {
  const current = await settings();
  return {
    configured: Boolean(current.token),
    apiBaseUrl: current.apiBaseUrl,
  };
}

function apiError(data, status) {
  const error = new Error(data.message || data.error || `API_${status}`);
  error.code = data.error || `API_${status}`;
  error.status = status;
  return error;
}

async function pairExtension(message) {
  const apiBaseUrl = String(message.apiBaseUrl || "").replace(/\/$/, "");
  const token = String(message.token || "").trim();
  if (!ALLOWED_API_BASE_URLS.has(apiBaseUrl) || !token.startsWith("gdxhs_"))
    throw new Error("配对信息无效");
  const previous = await chrome.storage.local.get(["apiBaseUrl", "token"]);
  await chrome.storage.local.set({ apiBaseUrl, token });
  try {
    const status = await api("/api/extensions/xiaohongshu/status");
    return { ok: true, status, deviceName: message.deviceName || "Chrome" };
  } catch (error) {
    if (previous.apiBaseUrl)
      await chrome.storage.local.set({ apiBaseUrl: previous.apiBaseUrl });
    else await chrome.storage.local.remove("apiBaseUrl");
    if (previous.token)
      await chrome.storage.local.set({ token: previous.token });
    else await chrome.storage.local.remove("token");
    throw error;
  }
}

function reportProgress(tabId, requestId, stage, message) {
  if (!tabId || !requestId) return Promise.resolve();
  return chrome.tabs
    .sendMessage(tabId, {
      type: "GD_XHS_UPLOAD_PROGRESS",
      requestId,
      progress: { stage, message },
    })
    .catch(() => undefined);
}

async function api(path, init = {}) {
  const current = await settings();
  if (!current.token) throw new Error("请先保存扩展配对令牌");
  const response = await fetch(`${current.apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${current.token}`,
      ...(init.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw apiError(data, response.status);
  return data;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 32_768;
  for (let index = 0; index < bytes.length; index += chunk)
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  return btoa(binary);
}

async function imageDataUrl(channel, taskId, imageIndex, deliveryKind) {
  const current = await settings();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  let response;
  try {
    response = await fetch(
      `${current.apiBaseUrl}${
        deliveryKind === "multi_account"
          ? `/api/extensions/deliveries/${taskId}/images/${imageIndex}`
          : `/api/extensions/${channel}/tasks/${taskId}/images/${imageIndex}`
      }`,
      {
        credentials: "omit",
        headers: { authorization: `Bearer ${current.token}` },
        signal: controller.signal,
      },
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw new Error("图片下载超时，请检查素材地址后重试");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.message || `图片下载失败：${response.status}`);
  }
  const mime = (response.headers.get("content-type") || "image/jpeg")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (
    !["image/jpeg", "image/png", "image/webp"].includes(mime) ||
    bytes.length === 0
  )
    throw new Error("图片响应格式无效");
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

async function creatorTab(channel) {
  // Never navigate an existing creator tab: it may contain an operator's
  // unsaved note. A dedicated tab also keeps each upload attempt isolated.
  const creatorUrl = CREATOR_URLS[channel];
  if (!creatorUrl) throw new Error("不支持的内容平台");
  const tab = await chrome.tabs.create({ url: creatorUrl, active: true });
  if (!tab.id) throw new Error(`无法打开${CHANNEL_NAMES[channel]}创作平台`);
  return tab.id;
}

async function waitForTab(tabId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("内容平台创作页加载超时");
}

async function contentScriptReady(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "GD_XHS_CONTENT_READY",
    });
    return response?.ready === true;
  } catch {
    return false;
  }
}

async function ensureContentScript(tabId) {
  // A normal navigation should mount the manifest content scripts. Give that
  // path a short grace period before injecting a recovery copy, so a healthy
  // page never receives duplicate upload listeners.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (await contentScriptReady(tabId)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // Updating/reloading an unpacked MV3 extension invalidates scripts that were
  // mounted in existing creator tabs. Reinject the audited adapter and upload
  // script instead of requiring operators to know that the tab must be
  // refreshed manually.
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["site-adapter.js", "article-site-adapter.js", "content-script.js"],
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await contentScriptReady(tabId)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw Object.assign(new Error("扩展内容脚本未就绪"), {
    code: "BROWSER_CONTENT_SCRIPT_NOT_READY",
  });
}

async function deliver(tabId, task) {
  const reportedResult = waitForContentResult(task.id);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: "GD_XHS_UPLOAD_TASK",
        task,
      });
      if (response?.result) return response;
      const result = await reportedResult;
      return result ? { ok: true, result } : response;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("扩展内容脚本未就绪");
}

async function startNextTask(
  taskId,
  channel = "xiaohongshu",
  progress = () => Promise.resolve(),
) {
  if (typeof taskId !== "string" || !taskId)
    throw new Error("必须从运营中心指定一个平台草稿任务");
  if (!CREATOR_URLS[channel]) throw new Error("不支持的内容平台");
  const channelName = CHANNEL_NAMES[channel];
  await progress("claiming", `正在领取指定的${channelName}草稿任务`);
  const claimed = await api(`/api/extensions/${channel}/tasks/claim`, {
    method: "POST",
    body: JSON.stringify({ taskId }),
  });
  if (!claimed.task)
    throw Object.assign(
      new Error(
        `当前${channelName}上传任务已被领取或状态已变化，请刷新任务详情后重试`,
      ),
      { code: "BROWSER_UPLOAD_TASK_NOT_CLAIMABLE" },
    );
  const task = claimed.task;
  let externalWriteMayHaveStarted = false;
  try {
    if (
      task.payload?.safety?.draftOnly !== true ||
      task.payload?.safety?.formalPublishForbidden !== true
    )
      throw new Error("服务器上传包缺少草稿安全门禁");
    if (
      !Array.isArray(task.payload?.images) ||
      task.payload.images.length === 0
    )
      throw Object.assign(
        new Error(`${channelName}图文草稿没有可上传图片，请先在复核页选择图片`),
        {
          code: "BROWSER_DRAFT_IMAGES_MISSING",
        },
      );
    const imageDataUrls = [];
    await progress("downloading", "正在下载已审核的配图");
    await api(`/api/extensions/${channel}/tasks/${task.id}/heartbeat`, {
      method: "POST",
      body: "{}",
    });
    for (
      let imageIndex = 0;
      imageIndex < task.payload.images.length;
      imageIndex += 1
    ) {
      imageDataUrls.push(await imageDataUrl(channel, task.id, imageIndex));
      await api(`/api/extensions/${channel}/tasks/${task.id}/heartbeat`, {
        method: "POST",
        body: "{}",
      });
    }
    const tabId = await creatorTab(channel);
    await progress("opening", `正在打开${channelName}创作页`);
    await waitForTab(tabId);
    await ensureContentScript(tabId);
    await api(`/api/extensions/${channel}/tasks/${task.id}/heartbeat`, {
      method: "POST",
      body: "{}",
    });
    externalWriteMayHaveStarted = true;
    await progress("uploading", `正在填写${channelName}标题、正文与配图`);
    const response = await deliver(tabId, { ...task, imageDataUrls });
    const result = response?.result || {
      status: "ambiguous",
      errorCode: "BROWSER_CONTENT_SCRIPT_NO_RESULT",
      message: "扩展未返回明确结果，系统不会自动重试。",
    };
    await api(`/api/extensions/${channel}/tasks/${task.id}/result`, {
      method: "POST",
      body: JSON.stringify(result),
    });
    await progress(
      result.status === "filled" || result.status === "drafted"
        ? "completed"
        : "attention",
      result.message || `${channelName}草稿处理完成`,
    );
    return { ok: true, taskId: task.id, result };
  } catch (error) {
    const result = {
      status: externalWriteMayHaveStarted ? "ambiguous" : "failed",
      errorCode: externalWriteMayHaveStarted
        ? "BROWSER_EXTENSION_INTERRUPTED"
        : error?.code || "BROWSER_UPLOAD_PREPARE_FAILED",
      message: error instanceof Error ? error.message : "扩展执行中断",
    };
    await api(`/api/extensions/${channel}/tasks/${task.id}/result`, {
      method: "POST",
      body: JSON.stringify(result),
    }).catch(() => undefined);
    return { ok: false, taskId: task.id, result };
  }
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function discoverAccountInTab(tabId) {
  await waitForTab(tabId);
  await ensureContentScript(tabId);
  const discovered = await chrome.tabs.sendMessage(tabId, {
    type: "GD_DISCOVER_ACCOUNT",
  });
  if (!discovered?.ok || !discovered.accountIdentity)
    throw Object.assign(new Error("未能确认当前平台登录账号，请登录后重试"), {
      code: discovered?.errorCode || "PLATFORM_ACCOUNT_NOT_DISCOVERED",
    });
  return {
    ...discovered,
    clientAccountKey: await sha256(discovered.accountIdentity),
  };
}

async function bindChannelAccount(channel) {
  if (!CREATOR_URLS[channel]) throw new Error("不支持的内容平台");
  const tabId = await creatorTab(channel);
  const discovered = await discoverAccountInTab(tabId);
  const registered = await api(`/api/extensions/${channel}/accounts/register`, {
    method: "POST",
    body: JSON.stringify({
      clientAccountKey: discovered.clientAccountKey,
      displayName: discovered.displayName,
      profileUrl: discovered.profileUrl,
      metadata: { hostname: new URL(CREATOR_URLS[channel]).hostname },
    }),
  });
  const stored = await chrome.storage.local.get(["boundAccounts"]);
  await chrome.storage.local.set({
    boundAccounts: {
      ...(stored.boundAccounts || {}),
      [channel]: {
        id: registered.account.id,
        key: discovered.clientAccountKey,
        displayName: discovered.displayName,
      },
    },
  });
  void pollDeliveryTasks();
  return registered;
}

async function deliveryHeartbeat(taskId) {
  return api(`/api/extensions/deliveries/${taskId}/heartbeat`, {
    method: "POST",
    body: "{}",
  });
}

async function startDeliveryTask(task) {
  let externalWriteMayHaveStarted = false;
  try {
    const tabId = await creatorTab(task.channel);
    const discovered = await discoverAccountInTab(tabId);
    if (discovered.clientAccountKey !== task.targetAccount?.key)
      throw Object.assign(
        new Error(
          `当前登录账号与目标账号“${task.targetAccount?.displayName || "未知账号"}”不一致，扩展已停止。`,
        ),
        { code: "DELIVERY_ACCOUNT_MISMATCH" },
      );
    await deliveryHeartbeat(task.id);
    const imageDataUrls = [];
    for (
      let imageIndex = 0;
      imageIndex < (task.payload?.images?.length || 0);
      imageIndex += 1
    ) {
      imageDataUrls.push(
        await imageDataUrl(task.channel, task.id, imageIndex, "multi_account"),
      );
      await deliveryHeartbeat(task.id);
    }
    externalWriteMayHaveStarted = true;
    const response = await deliver(tabId, {
      ...task,
      deliveryKind: "multi_account",
      imageDataUrls,
    });
    const result = response?.result || {
      status: "ambiguous",
      errorCode: "BROWSER_CONTENT_SCRIPT_NO_RESULT",
      message: "扩展未返回明确结果，系统不会自动重试。",
    };
    await api(`/api/extensions/deliveries/${task.id}/result`, {
      method: "POST",
      body: JSON.stringify(result),
    });
    return result;
  } catch (error) {
    const result = {
      status: externalWriteMayHaveStarted ? "ambiguous" : "manual_review",
      errorCode: error?.code || "MULTI_ACCOUNT_DELIVERY_STOPPED",
      message: error instanceof Error ? error.message : "多账号投放已安全停止",
    };
    await api(`/api/extensions/deliveries/${task.id}/result`, {
      method: "POST",
      body: JSON.stringify(result),
    }).catch(() => undefined);
    return result;
  }
}

async function pollDeliveryTasks() {
  if (deliveryPollRunning) return;
  deliveryPollRunning = true;
  try {
    const current = await settings();
    if (!current.token) return;
    const claimed = await api("/api/extensions/deliveries/claim", {
      method: "POST",
      body: "{}",
    });
    if (claimed.task) await startDeliveryTask(claimed.task);
  } catch {
    // Connection and authentication state is surfaced in the operations
    // center. Background polling must never affect the legacy manual flow.
  } finally {
    deliveryPollRunning = false;
  }
}

chrome.alarms.create("gd-delivery-poll", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "gd-delivery-poll") void pollDeliveryTasks();
});
void pollDeliveryTasks();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "CONTENT_TASK_RESULT") {
    pendingContentResults.get(message.taskId)?.(message.result);
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "LOCAL_STATUS") {
    localStatus()
      .then(sendResponse)
      .catch(() => sendResponse({ configured: false }));
    return true;
  }
  if (message?.type === "PAIR_EXTENSION") {
    pairExtension(message)
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "配对失败",
        }),
      );
    return true;
  }
  if (message?.type === "CHECK_CONNECTION") {
    api("/api/extensions/xiaohongshu/status")
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "连接检查失败",
          reconnectRequired:
            error?.code === "EXTENSION_UNAUTHORIZED" || error?.status === 401,
        }),
      );
    return true;
  }
  if (message?.type === "BIND_CHANNEL_ACCOUNT") {
    bindChannelAccount(message.channel)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "账号绑定失败",
          errorCode: error?.code,
        }),
      );
    return true;
  }
  if (message?.type === "START_NEXT_TASK") {
    sendResponse({
      ok: false,
      error: "请从极客跳动 AI 运营中心的指定任务发起上传。",
    });
    return false;
  }
  if (message?.type === "START_TASK") {
    const progress = (stage, text) =>
      reportProgress(_sender.tab?.id, message.requestId, stage, text);
    startNextTask(message.taskId, message.channel || "xiaohongshu", progress)
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "任务启动失败",
        }),
      );
    return true;
  }
  if (message?.type === "TASK_HEARTBEAT") {
    api(
      message.deliveryKind === "multi_account"
        ? `/api/extensions/deliveries/${message.taskId}/heartbeat`
        : `/api/extensions/${message.channel || "xiaohongshu"}/tasks/${message.taskId}/heartbeat`,
      {
        method: "POST",
        body: "{}",
      },
    )
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  return undefined;
});
