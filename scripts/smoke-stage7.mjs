import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const envText = await readFile(
  process.env.SMOKE_ENV_FILE ?? new URL("../.env", import.meta.url),
  "utf8",
);
const env = {
  ...Object.fromEntries(
    envText
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  ),
  ...process.env,
};
const baseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:4000";
const terminalStatuses = new Set([
  "drafted",
  "partial",
  "manual_review",
  "failed",
  "cancelled",
]);

class ApiClient {
  cookies = new Map();

  capture(response) {
    const values =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie")].filter(Boolean);
    for (const value of values) {
      const pair = value.split(";", 1)[0];
      const index = pair.indexOf("=");
      if (index > 0)
        this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }

  cookieHeader() {
    return [...this.cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  async raw(path, init = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        ...(this.cookies.size ? { cookie: this.cookieHeader() } : {}),
      },
    });
    this.capture(response);
    return response;
  }

  async json(path, init = {}) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await this.raw(path, init);
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

  async csrf() {
    return (await this.json("/api/auth/csrf")).csrfToken;
  }

  async mutate(path, method, body) {
    return this.json(path, {
      method,
      headers: {
        "x-csrf-token": await this.csrf(),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  async uploadAttachment(name, bytes, type) {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type }), name);
    return this.json("/api/attachments/upload", {
      method: "POST",
      headers: { "x-csrf-token": await this.csrf() },
      body: form,
    });
  }
}

async function waitForJob(client, jobId, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  let lastJob;
  while (Date.now() < deadline) {
    const { job } = await client.json(`/api/content-jobs/${jobId}`);
    lastJob = job;
    if (terminalStatuses.has(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `任务 ${jobId} 未在 ${Math.round(timeout / 1_000)} 秒内结束：${lastJob?.status ?? "unknown"}/${lastJob?.progress?.stage ?? "unknown"}/${lastJob?.progress?.message ?? "无进度说明"}`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function mutateDatabase(sql) {
  const user = env.POSTGRES_USER || "geekdance_ops";
  const database = env.POSTGRES_DB || "geekdance_ops";
  if (!/^[a-zA-Z0-9_]+$/.test(user) || !/^[a-zA-Z0-9_]+$/.test(database))
    throw new Error("数据库测试标识符不安全");
  const container = process.env.SMOKE_POSTGRES_CONTAINER;
  const args = container
    ? [
        "exec",
        "-i",
        container,
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        user,
        "-d",
        database,
        "-c",
        sql,
      ]
    : [
        "compose",
        "exec",
        "-T",
        "postgres",
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        user,
        "-d",
        database,
        "-c",
        sql,
      ];
  execFileSync("docker", args, { cwd: rootDir, stdio: "pipe" });
}

const admin = new ApiClient();
const adminLogin = await admin.mutate("/api/auth/login", "POST", {
  email: env.BOOTSTRAP_ADMIN_EMAIL,
  password: env.BOOTSTRAP_ADMIN_PASSWORD,
});
if (adminLogin.user.mustChangePassword) {
  const nextAdminPassword =
    env.SMOKE_ADMIN_PERMANENT_PASSWORD ?? `Stage7!Admin-${randomUUID()}`;
  await admin.mutate("/api/auth/change-password", "POST", {
    currentPassword: env.BOOTSTRAP_ADMIN_PASSWORD,
    newPassword: nextAdminPassword,
  });
}
const previousMembers = (await admin.json("/api/admin/users")).users;
for (const member of previousMembers.filter(
  (item) =>
    item.status === "active" &&
    item.email.startsWith("stage7-") &&
    item.role === "operator",
))
  await admin.mutate(`/api/admin/users/${member.id}`, "PATCH", {
    status: "disabled",
  });

const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const operatorEmail = `stage7-${suffix}@geekdance.local`;
const temporaryPassword = `Stage7!Temp-${randomUUID()}`;
const permanentPassword = `Stage7!Ready-${randomUUID()}`;
const createdMember = await admin.mutate("/api/admin/users", "POST", {
  email: operatorEmail,
  name: "第7阶段运营验收",
  role: "operator",
  temporaryPassword,
});

const operator = new ApiClient();
const firstLogin = await operator.mutate("/api/auth/login", "POST", {
  email: operatorEmail,
  password: temporaryPassword,
});
assert(firstLogin.user.mustChangePassword, "首次登录未要求修改临时密码");
const blockedBeforePasswordChange = await operator.raw("/api/content-jobs");
assert(
  blockedBeforePasswordChange.status === 428,
  "首次登录密码门禁未在后端生效",
);
await operator.mutate("/api/auth/change-password", "POST", {
  currentPassword: temporaryPassword,
  newPassword: permanentPassword,
});
assert(
  !(await operator.json("/api/auth/me")).user.mustChangePassword,
  "临时密码修改状态未更新",
);
assert(
  (await operator.raw("/api/admin/users")).status === 403 &&
    (await operator.raw("/api/admin/automation-schedules")).status === 403,
  "运营成员访问管理员接口未被拒绝",
);

const persistedDefaultRemarks = `第7阶段默认指令持久化验收：${suffix}，仅用于当前临时运营账号。`;
const savedContentPreferences = await operator.mutate(
  "/api/content-preferences",
  "PUT",
  { defaultRemarks: persistedDefaultRemarks },
);
assert(
  savedContentPreferences.defaultRemarks === persistedDefaultRemarks,
  "默认指令保存接口未返回已保存内容",
);
assert(
  (await operator.json("/api/content-preferences")).defaultRemarks ===
    persistedDefaultRemarks,
  "默认指令保存后重新读取不一致",
);
const refreshedOperator = new ApiClient();
await refreshedOperator.mutate("/api/auth/login", "POST", {
  email: operatorEmail,
  password: permanentPassword,
});
assert(
  (await refreshedOperator.json("/api/content-preferences")).defaultRemarks ===
    persistedDefaultRemarks,
  "新会话未读取到已保存的默认指令",
);

const invalidForm = new FormData();
invalidForm.append(
  "file",
  new Blob([new Uint8Array([0x4d, 0x5a, 0x00, 0x01])], {
    type: "text/plain",
  }),
  "伪装资料.txt",
);
const invalidUpload = await operator.raw("/api/attachments/upload", {
  method: "POST",
  headers: { "x-csrf-token": await operator.csrf() },
  body: invalidForm,
});
assert(invalidUpload.status === 400, "附件魔数与内容校验未拒绝伪装文件");

const adminAttachment = await admin.uploadAttachment(
  "admin-private.md",
  new TextEncoder().encode("管理员私有附件，不应被运营成员跨账号使用。"),
  "text/markdown",
);
const forbiddenAttachmentResponse = await operator.raw("/api/content-jobs", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-csrf-token": await operator.csrf(),
  },
  body: JSON.stringify({
    operationId: randomUUID(),
    topic: "跨账号附件权限验收",
    readerMode: "general",
    sourceRefs: [],
    attachmentIds: [adminAttachment.attachment.id],
    targets: ["official_site"],
    imageMode: "geekhome",
  }),
});
assert(
  forbiddenAttachmentResponse.status === 400,
  "运营成员能够引用管理员私有附件",
);

const attachment = await operator.uploadAttachment(
  "stage7-reference.md",
  new TextEncoder().encode(
    "# 第7阶段参考资料\n\n企业内容自动化需要保留证据清单、人工审核边界和双渠道独立结果。",
  ),
  "text/markdown",
);
assert(
  attachment.attachment.extractionStatus === "ready",
  "Markdown 附件未完成文本解析",
);
const imageAttachment = await operator.uploadAttachment(
  "stage7-visual.png",
  await readFile(
    new URL("../apps/web/public/brand/geekdance-logo.png", import.meta.url),
  ),
  "image/png",
);
assert(
  imageAttachment.attachment.extractionStatus === "vision_required",
  "图片附件未进入视觉资料流程",
);
const extraAttachmentIds = [];
const extraFixtureChecks = [];
if (process.platform === "darwin") {
  const readmePath = fileURLToPath(new URL("../README.md", import.meta.url));
  const docxPath = `/tmp/geekdance-stage7-${suffix}.docx`;
  execFileSync(
    "/usr/bin/textutil",
    ["-convert", "docx", "-output", docxPath, readmePath],
    { stdio: "pipe" },
  );
  const docxAttachment = await operator.uploadAttachment(
    "stage7-reference.docx",
    await readFile(docxPath),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  await unlink(docxPath).catch(() => undefined);
  assert(
    docxAttachment.attachment.extractionStatus === "ready",
    "DOCX 附件未完成文本解析",
  );
  const pdfBytes = execFileSync(
    "/usr/sbin/cupsfilter",
    ["-m", "application/pdf", readmePath],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const pdfAttachment = await operator.uploadAttachment(
    "stage7-reference.pdf",
    pdfBytes,
    "application/pdf",
  );
  assert(
    pdfAttachment.attachment.extractionStatus === "ready",
    "PDF 附件未完成文本解析",
  );
  extraAttachmentIds.push(
    docxAttachment.attachment.id,
    pdfAttachment.attachment.id,
  );
  extraFixtureChecks.push("docx_extraction", "pdf_extraction");
}

const adminJobCreated = await admin.mutate("/api/content-jobs", "POST", {
  operationId: randomUUID(),
  topic: "【第7阶段】管理员任务隔离验收",
  readerMode: "general",
  sourceRefs: [],
  attachmentIds: [],
  targets: ["official_site"],
  imageMode: "geekhome",
  confirmDraft: true,
});
const adminJob = await waitForJob(admin, adminJobCreated.job.id);
assert(adminJob.status === "drafted", "管理员隔离基准任务未完成");
const sharedAdminJob = await operator.json(`/api/content-jobs/${adminJob.id}`);
assert(
  sharedAdminJob.job.id === adminJob.id && !sharedAdminJob.job.canManage,
  "运营成员无法只读查看团队任务",
);
assert(
  (await operator.json("/api/content-jobs")).jobs.some(
    (item) => item.id === adminJob.id && !item.canManage,
  ),
  "团队任务未出现在运营成员任务列表",
);
assert(
  (
    await operator.raw(`/api/content-jobs/${adminJob.id}/trash`, {
      method: "POST",
      headers: { "x-csrf-token": await operator.csrf() },
    })
  ).status === 404,
  "运营成员能够修改其他成员创建的任务",
);

const operationId = randomUUID();
const contentInput = {
  operationId,
  topic: "【第7阶段】AI 内容自动化如何稳定进入企业运营流程",
  title: "【第7阶段验收】企业 AI 内容自动化的落地边界",
  readerMode: "general",
  sourceRefs: ["https://example.com/stage7-primary-source"],
  attachmentIds: [
    attachment.attachment.id,
    imageAttachment.attachment.id,
    ...extraAttachmentIds,
  ],
  targets: ["official_site", "wechat"],
  imageMode: "geekhome",
  primaryTag: "AI 应用",
  secondaryTags: ["内容自动化", "智能体"],
  remarks: "本地完整验收，只创建 Mock 草稿，不正式发布",
  confirmDraft: true,
};
const sharedCsrf = await operator.csrf();
const repeated = await Promise.all(
  Array.from({ length: 20 }, async () => {
    const response = await operator.raw("/api/content-jobs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": sharedCsrf,
      },
      body: JSON.stringify(contentInput),
    });
    const data = await response.json();
    assert(response.ok, `并发幂等提交失败：${response.status}`);
    return data;
  }),
);
const jobIds = new Set(repeated.map((item) => item.job.id));
assert(jobIds.size === 1, "20 次并发重复提交产生了多个任务");
const jobId = [...jobIds][0];
const dualJob = await waitForJob(operator, jobId);
assert(dualJob.status === "drafted", "双渠道内容任务未完成");
assert(
  dualJob.targets.length === 2 &&
    dualJob.targets.every((target) => target.status === "drafted"),
  "双渠道 Mock 草稿结果不完整",
);
assert(dualJob.qaReport?.passed, "文章质检未通过");
assert(
  dualJob.evidence.filter((item) => item.sourceType === "user_attachment")
    .length ===
    2 + extraAttachmentIds.length,
  "附件未进入证据清单",
);
assert(
  dualJob.result?.officialSiteHtml &&
    dualJob.result?.wechatHtml &&
    dualJob.result.officialSiteHtml !== dualJob.result.wechatHtml,
  "官网与公众号未生成独立排版产物",
);
assert(
  (await admin.json(`/api/content-jobs/${dualJob.id}`)).job.id === dualJob.id,
  "管理员无法读取运营成员任务",
);

const officialBeforeRetry = dualJob.targets.find(
  (target) => target.target === "official_site",
).externalDraftId;
mutateDatabase(
  `UPDATE job_targets SET status = 'failed', error_code = 'STAGE7_SIMULATED_FAILURE', updated_at = NOW() WHERE job_id = '${dualJob.id}' AND target = 'wechat'; UPDATE content_jobs SET status = 'partial', updated_at = NOW() WHERE id = '${dualJob.id}';`,
);
const retryAccepted = await operator.mutate(
  `/api/content-jobs/${dualJob.id}/retry`,
  "POST",
);
assert(
  retryAccepted.targets.length === 1 && retryAccepted.targets[0] === "wechat",
  "重试接口未限定为失败渠道",
);
const retried = await waitForJob(operator, dualJob.id);
assert(
  retried.status === "drafted" &&
    retried.targets.every((target) => target.status === "drafted"),
  "失败渠道重试后未恢复双渠道草稿状态",
);
assert(
  retried.targets.find((target) => target.target === "official_site")
    .externalDraftId === officialBeforeRetry,
  "失败渠道重试错误地重复创建了官网草稿",
);

const schedule = await admin.mutate("/api/admin/automation-schedules", "POST", {
  name: `第7阶段任意时间验收-${suffix}`,
  enabled: false,
  cronExpression: "23 16 * * *",
  timezone: "Asia/Shanghai",
  template: {
    topic: "第7阶段定时草稿验收",
    readerMode: "general",
    sourceRefs: [],
    imageMode: "generated",
    targets: [
      "official_site",
      "wechat",
      "xiaohongshu",
      "zhihu",
      "toutiao",
      "baijiahao",
      "linkedin",
    ],
  },
});
assert(
  schedule.schedule.cronExpression === "23 16 * * *" &&
    !schedule.schedule.enabled,
  "任意时间定时任务默认停用验收失败",
);

const enabledSchedule = await admin.mutate(
  `/api/admin/automation-schedules/${schedule.schedule.id}`,
  "PATCH",
  {
    ...schedule.schedule,
    enabled: true,
  },
);
assert(enabledSchedule.schedule.enabled, "定时任务启用失败");
assert(
  (await admin.json("/api/admin/automation-schedules")).schedules.some(
    (item) => item.id === schedule.schedule.id && item.enabled,
  ),
  "启用后的定时任务未在列表中生效",
);

const disabledSchedule = await admin.mutate(
  `/api/admin/automation-schedules/${schedule.schedule.id}`,
  "PATCH",
  {
    ...schedule.schedule,
    enabled: false,
  },
);
assert(!disabledSchedule.schedule.enabled, "定时任务停用失败");

const manualRun = await admin.mutate(
  `/api/admin/automation-schedules/${schedule.schedule.id}/run`,
  "POST",
);
assert(
  manualRun.accepted && typeof manualRun.triggerId === "string",
  "定时任务立即运行请求未被接受",
);

let automatedContentJobId;
const automationDeadline = Date.now() + 60_000;
while (Date.now() < automationDeadline) {
  const schedules = (await admin.json("/api/admin/automation-schedules"))
    .schedules;
  automatedContentJobId = schedules.find(
    (item) => item.id === schedule.schedule.id,
  )?.lastJobId;
  if (automatedContentJobId) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
assert(automatedContentJobId, "立即运行后未生成内容任务");

const automatedJob = await waitForJob(admin, automatedContentJobId);
assert(
  automatedJob.status === "manual_review" &&
    automatedJob.targets.length === 7 &&
    automatedJob.targets.every(
      (target) =>
        target.status === "manual_review" && !target.externalDraftId,
    ),
  `七渠道自动化任务未在外部写入前停在人工复核：${JSON.stringify({
    status: automatedJob.status,
    targets: automatedJob.targets.map((target) => ({
      target: target.target,
      status: target.status,
      errorCode: target.errorCode,
      externalDraftId: target.externalDraftId,
    })),
  })}`,
);
const automatedReviews = (
  await admin.json("/api/manual-reviews?status=pending")
).reviews.filter((item) => item.contentJobId === automatedContentJobId);
assert(automatedReviews.length === 7, "七渠道自动化复核单未完整生成");
for (const target of [
  "official_site",
  "wechat",
  "xiaohongshu",
  "zhihu",
  "toutiao",
  "baijiahao",
  "linkedin",
]) {
  const review = automatedReviews.find((item) => item.target === target);
  const article = automatedJob.result?.channelArticles?.[target];
  assert(review?.id && article?.title, `${target} 自动化复核产物缺失`);
  const existingImages = (
    automatedJob.result?.channelArtifacts?.[target]?.assets ?? []
  )
    .flatMap((asset) =>
      asset?.selected?.url
        ? [
            {
              source: "existing",
              url: asset.selected.url,
              placement: asset.placement,
            },
          ]
        : [],
    )
    .filter(
      (image, index, images) =>
        images.findIndex((candidate) => candidate.url === image.url) === index,
    );
  const revision = { article, images: existingImages };
  const preview = await admin.mutate(
    `/api/manual-reviews/${review.id}/preview`,
    "POST",
    revision,
  );
  assert(preview.html?.length > 300, `${target} 自动化复核预览未生成`);
  await admin.mutate(`/api/manual-reviews/${review.id}/decision`, "POST", {
    decision: "approve_content",
    note: `隔离回归：${target} 自动化内容已核对`,
    artifactRevision: revision,
  });
}

const browserTargets = [
  "xiaohongshu",
  "zhihu",
  "toutiao",
  "baijiahao",
  "linkedin",
];
let automatedAfterReview;
for (let attempt = 0; attempt < 240; attempt += 1) {
  automatedAfterReview = (
    await admin.json(`/api/content-jobs/${automatedContentJobId}`)
  ).job;
  const officialReady = automatedAfterReview.targets
    .filter((target) => ["official_site", "wechat"].includes(target.target))
    .every((target) => target.status === "drafted");
  const browserReady = automatedAfterReview.targets
    .filter((target) => browserTargets.includes(target.target))
    .every(
      (target) =>
        target.status === "waiting_for_uploader" && target.uploadTask?.id,
    );
  if (officialReady && browserReady) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
assert(
  automatedAfterReview.targets
    .filter((target) => ["official_site", "wechat"].includes(target.target))
    .every(
      (target) =>
        target.status === "drafted" &&
        String(target.externalDraftId ?? "").startsWith("mock-"),
    ),
  "自动化复核通过后官网或公众号 Mock 草稿未创建",
);
const automationToken = await admin.mutate("/api/extension-tokens", "POST", {
  name: "七渠道自动化隔离回归扩展",
});
const automationExtensionAuth = {
  authorization: `Bearer ${automationToken.token.token}`,
};
for (const channel of browserTargets) {
  const target = automatedAfterReview.targets.find(
    (item) => item.target === channel,
  );
  assert(
    target?.status === "waiting_for_uploader" && target.uploadTask?.id,
    `${channel} 自动化复核通过后未生成扩展上传包`,
  );
  const claimed = await admin.json(`/api/extensions/${channel}/tasks/claim`, {
    method: "POST",
    headers: {
      ...automationExtensionAuth,
      "content-type": "application/json",
    },
    body: JSON.stringify({ taskId: target.uploadTask.id }),
  });
  assert(claimed.task?.id === target.uploadTask.id, `${channel} 上传包领取失败`);
  await admin.json(
    `/api/extensions/${channel}/tasks/${target.uploadTask.id}/result`,
    {
      method: "POST",
      headers: {
        ...automationExtensionAuth,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        status: "drafted",
        draftSaved: true,
        saveSignal: `${channel}-isolated-draft-saved`,
        platformDraftId: `mock-${channel}-${randomUUID()}`,
      }),
    },
  );
}
const automatedDrafted = await waitForJob(admin, automatedContentJobId);
assert(
  automatedDrafted.status === "drafted" &&
    automatedDrafted.targets.every((target) => target.status === "drafted"),
  "七渠道自动化复核与草稿闭环未全部完成",
);
const automationDashboard = await admin.json("/api/dashboard");
assert(
  automationDashboard.automation.latestRun?.contentJobId ===
    automatedContentJobId &&
    automationDashboard.automation.latestRun.status === "drafted",
  "自动化运行终态未同步到工作台",
);
await admin.mutate(
  `/api/admin/automation-schedules/${schedule.schedule.id}`,
  "DELETE",
);
assert(
  !(await admin.json("/api/admin/automation-schedules")).schedules.some(
    (item) => item.id === schedule.schedule.id,
  ),
  "定时任务删除后仍然存在",
);

await operator.mutate(`/api/content-jobs/${retried.id}/trash`, "POST");
assert(
  !(await operator.json("/api/content-jobs")).jobs.some(
    (item) => item.id === retried.id,
  ) &&
    (await operator.json("/api/content-jobs?view=trash")).jobs.some(
      (item) => item.id === retried.id,
    ),
  "任务移入回收站后的列表隔离未生效",
);
await operator.mutate(`/api/content-jobs/${retried.id}/restore`, "POST");
assert(
  (await operator.json("/api/content-jobs")).jobs.some(
    (item) => item.id === retried.id,
  ),
  "回收站任务恢复失败",
);
await operator.mutate(`/api/content-jobs/${retried.id}/trash`, "POST");
await operator.mutate(`/api/content-jobs/${retried.id}`, "DELETE");
assert(
  (await operator.raw(`/api/content-jobs/${retried.id}`)).status === 404,
  "回收站任务永久删除失败",
);

await admin.mutate(`/api/admin/users/${createdMember.id}`, "PATCH", {
  status: "disabled",
});
assert(
  (await operator.raw("/api/auth/me")).status === 401,
  "停用成员后旧会话仍然有效",
);

console.log(
  JSON.stringify({
    ok: true,
    jobId: dualJob.id,
    verified: [
      "two_account_login",
      "forced_password_change_backend_gate",
      "operator_admin_api_denied",
      "default_content_instructions_persist_after_refresh",
      "default_content_instructions_persist_across_sessions",
      "automation_enable_disable",
      "automation_manual_run",
      "automation_run_record_visible",
      "automation_seven_channel_review_and_draft_flow",
      "automation_delete",
      "member_disable_invalidates_session",
      "attachment_magic_validation",
      "markdown_extraction",
      "image_attachment_vision_routing",
      ...extraFixtureChecks,
      "attachment_ownership_isolation",
      "attachment_evidence_traceability",
      "cross_user_job_isolation",
      "dual_channel_independent_artifacts",
      "twenty_concurrent_idempotent_submissions",
      "retry_failed_channel_only",
      "successful_channel_not_duplicated",
      "arbitrary_daily_schedule_disabled_by_default",
      "task_trash_list_isolation",
      "task_restore",
      "task_permanent_delete",
    ],
  }),
);
