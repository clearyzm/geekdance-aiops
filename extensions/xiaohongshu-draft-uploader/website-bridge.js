(() => {
  if (globalThis.__GD_XHS_WEBSITE_BRIDGE_ACTIVE__) return;
  globalThis.__GD_XHS_WEBSITE_BRIDGE_ACTIVE__ = true;

  const allowedOrigins = new Set([
    "https://aiops.geekdance.cn",
    "http://127.0.0.1:3000",
    "http://localhost:3000",
  ]);
  const allowedOrigin = location.origin;
  if (!allowedOrigins.has(allowedOrigin)) return;

  function respond(requestId, type, result) {
    window.postMessage({ type, requestId, result }, allowedOrigin);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (
      message?.type === "GD_XHS_UPLOAD_PROGRESS" &&
      typeof message.requestId === "string"
    )
      respond(message.requestId, "GD_XHS_UPLOAD_PROGRESS", message.progress);
  });

  window.addEventListener("message", (event) => {
    if (
      event.source === window &&
      event.origin === allowedOrigin &&
      event.data?.type === "GD_XHS_PING" &&
      typeof event.data?.requestId === "string"
    ) {
      chrome.runtime.sendMessage({ type: "LOCAL_STATUS" }, (result) => {
        window.postMessage(
          {
            type: "GD_XHS_PONG",
            requestId: event.data.requestId,
            version: chrome.runtime.getManifest().version,
            configured: result?.configured === true,
          },
          allowedOrigin,
        );
      });
      return;
    }
    if (
      event.source === window &&
      event.origin === allowedOrigin &&
      event.data?.type === "GD_BIND_CHANNEL_ACCOUNT" &&
      typeof event.data?.requestId === "string" &&
      typeof event.data?.channel === "string"
    ) {
      const { requestId, channel } = event.data;
      chrome.runtime.sendMessage(
        { type: "BIND_CHANNEL_ACCOUNT", channel },
        (result) =>
          respond(requestId, "GD_BIND_CHANNEL_ACCOUNT_RESULT", result),
      );
      return;
    }
    if (
      event.source === window &&
      event.origin === allowedOrigin &&
      event.data?.type === "GD_XHS_CHECK_CONNECTION" &&
      typeof event.data?.requestId === "string"
    ) {
      const { requestId } = event.data;
      chrome.runtime.sendMessage({ type: "CHECK_CONNECTION" }, (result) =>
        respond(requestId, "GD_XHS_CONNECTION_RESULT", result),
      );
      return;
    }
    if (
      event.source === window &&
      event.origin === allowedOrigin &&
      event.data?.type === "GD_XHS_PAIR" &&
      typeof event.data?.requestId === "string" &&
      typeof event.data?.token === "string"
    ) {
      const { requestId, token, deviceName } = event.data;
      chrome.runtime.sendMessage(
        {
          type: "PAIR_EXTENSION",
          apiBaseUrl:
            allowedOrigin === "https://aiops.geekdance.cn"
              ? allowedOrigin
              : "http://127.0.0.1:4000",
          token,
          deviceName,
        },
        (result) => respond(requestId, "GD_XHS_PAIR_RESULT", result),
      );
      return;
    }
    if (
      event.source !== window ||
      event.origin !== allowedOrigin ||
      event.data?.type !== "GD_XHS_START_UPLOAD" ||
      typeof event.data?.requestId !== "string" ||
      typeof event.data?.taskId !== "string"
    )
      return;
    const { requestId, taskId, channel = "xiaohongshu" } = event.data;
    chrome.runtime.sendMessage(
      { type: "START_TASK", taskId, channel, requestId },
      (result) => {
        window.postMessage(
          {
            type: "GD_XHS_UPLOAD_RESULT",
            requestId,
            result:
              result ||
              (chrome.runtime.lastError
                ? { ok: false, error: chrome.runtime.lastError.message }
                : { ok: false, error: "扩展没有返回结果" }),
          },
          allowedOrigin,
        );
      },
    );
  });
})();
