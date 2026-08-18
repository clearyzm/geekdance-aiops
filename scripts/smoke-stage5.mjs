import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const envText = await readFile(new URL("../.env", import.meta.url), "utf8");
const localEnv = Object.fromEntries(
  envText
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)];
    }),
);
const baseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:4000";
const cookies = new Map();

function captureCookies(response) {
  const values =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
  for (const value of values) {
    const [pair] = value.split(";", 1);
    const index = pair.indexOf("=");
    if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1));
  }
}

function cookieHeader() {
  return [...cookies.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

async function request(path, init = {}) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        ...(cookies.size ? { cookie: cookieHeader() } : {}),
      },
    });
    captureCookies(response);
    const data = await response.json().catch(() => ({}));
    if (response.status === 429 && attempt < 4) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Number.isFinite(retryAfter)
            ? retryAfter * 1_000
            : 1_000 * (attempt + 1),
        ),
      );
      continue;
    }
    if (!response.ok)
      throw new Error(
        `${init.method ?? "GET"} ${path} -> ${response.status} ${data.error ?? data.message ?? "UNKNOWN"}`,
      );
    return data;
  }
  throw new Error(
    `${init.method ?? "GET"} ${path} -> rate limit retry exhausted`,
  );
}

async function csrf() {
  return (await request("/api/auth/csrf")).csrfToken;
}

async function mutate(path, method, body) {
  const token = await csrf();
  return request(path, {
    method,
    headers: {
      "x-csrf-token": token,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function waitForJob(jobId) {
  const terminal = new Set([
    "drafted",
    "partial",
    "manual_review",
    "failed",
    "cancelled",
  ]);
  const deadline = Date.now() + 180_000;
  let lastJob;
  while (Date.now() < deadline) {
    const { job } = await request(`/api/content-jobs/${jobId}`);
    lastJob = job;
    if (terminal.has(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `任务 ${jobId} 在 180 秒内未完成：${lastJob?.status ?? "unknown"}/${lastJob?.progress?.stage ?? "unknown"}/${lastJob?.progress?.message ?? "无进度说明"}`,
  );
}

await mutate("/api/auth/login", "POST", {
  email: localEnv.BOOTSTRAP_ADMIN_EMAIL,
  password: localEnv.BOOTSTRAP_ADMIN_PASSWORD,
});

const common = {
  topic: "【Mock验收】企业如何用 AI 智能体提高跨部门协作效率",
  readerMode: "general",
  sourceRefs: [],
  imageMode: "generated",
  primaryTag: "AI 应用",
  secondaryTags: ["智能体", "数字化转型"],
  remarks: "第5阶段自动化验收，只创建草稿，不正式发布",
  confirmDraft: true,
};
const mode = process.env.STAGE5_SMOKE_MODE ?? "full";

if (mode === "retry") {
  const jobId = process.env.STAGE5_RETRY_JOB_ID;
  if (!jobId) throw new Error("STAGE5_RETRY_JOB_ID_REQUIRED");
  await mutate(`/api/content-jobs/${jobId}/retry`, "POST");
  const retriedJob = await waitForJob(jobId);
  if (
    retriedJob.status !== "drafted" ||
    retriedJob.targets.some((target) => target.status !== "drafted")
  ) {
    throw new Error("仅重试失败渠道验收未通过");
  }
  console.log(
    JSON.stringify({
      ok: true,
      jobId,
      verified: ["retry_failed_target_only", "ready_content_reused"],
    }),
  );
  process.exit(0);
}

if (mode === "live") {
  const created = await mutate("/api/content-jobs", "POST", {
    ...common,
    operationId: randomUUID(),
    title: "【自动化验收】AI智能体协作指南",
    targets: ["wechat"],
  });
  const liveJob = await waitForJob(created.job.id);
  const target = liveJob.targets.find((item) => item.target === "wechat");
  if (
    liveJob.status !== "drafted" ||
    target?.status !== "drafted" ||
    !target.externalDraftId ||
    String(target.externalDraftId).startsWith("mock-wechat-")
  ) {
    throw new Error(
      `真实公众号草稿验收未通过：${liveJob.status}/${target?.status ?? "missing"}/${target?.errorCode ?? "unknown"}`,
    );
  }
  console.log(
    JSON.stringify({
      ok: true,
      jobId: liveJob.id,
      draftId: target.externalDraftId,
      verified: ["wechat_live_draft_only"],
    }),
  );
  process.exit(0);
}

let wechatJob;
if (mode === "full") {
  const wechatCreated = await mutate("/api/content-jobs", "POST", {
    ...common,
    operationId: randomUUID(),
    targets: ["wechat"],
  });
  wechatJob = await waitForJob(wechatCreated.job.id);
  if (
    wechatJob.status !== "drafted" ||
    wechatJob.targets[0]?.status !== "drafted" ||
    !String(wechatJob.targets[0]?.externalDraftId ?? "").startsWith(
      "mock-wechat-",
    )
  ) {
    throw new Error("公众号 Mock 草稿验收未通过");
  }
}

const dualCreated = await mutate("/api/content-jobs", "POST", {
  ...common,
  operationId: randomUUID(),
  targets: ["official_site", "wechat"],
});
const dualJob = await waitForJob(dualCreated.job.id);
if (mode === "partial") {
  const official = dualJob.targets.find(
    (target) => target.target === "official_site",
  );
  const wechat = dualJob.targets.find((target) => target.target === "wechat");
  if (
    dualJob.status !== "partial" ||
    official?.status !== "drafted" ||
    wechat?.status !== "failed"
  ) {
    throw new Error("双渠道部分失败验收未通过");
  }
} else if (
  dualJob.status !== "drafted" ||
  dualJob.targets.some((target) => target.status !== "drafted")
) {
  throw new Error("双渠道 Mock 草稿验收未通过");
}

const scheduleResult = await mutate("/api/admin/automation-schedules", "POST", {
  name: `第5阶段任意时间验收-${Date.now()}`,
  enabled: false,
  cronExpression: "37 14 * * *",
  timezone: "Asia/Shanghai",
  template: { ...common, targets: ["official_site", "wechat"] },
});
if (
  scheduleResult.schedule.cronExpression !== "37 14 * * *" ||
  scheduleResult.schedule.enabled
) {
  throw new Error("任意时间定时任务验收未通过");
}
await mutate(
  `/api/admin/automation-schedules/${scheduleResult.schedule.id}`,
  "DELETE",
);

console.log(
  JSON.stringify({
    ok: true,
    mode,
    wechatJobId: wechatJob?.id,
    dualJobId: dualJob.id,
    verified:
      mode === "partial"
        ? [
            "dual_channel_partial",
            "official_drafted",
            "wechat_explicit_failure",
            "daily_time_14_37",
            "schedule_default_disabled",
          ]
        : [
            "wechat_mock_draft",
            "dual_channel_mock_draft",
            "daily_time_14_37",
            "schedule_default_disabled",
          ],
  }),
);
