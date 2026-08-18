import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const env = {
  ...Object.fromEntries(
    (
      await readFile(
        process.env.SMOKE_ENV_FILE ?? new URL("../.env", import.meta.url),
        "utf8",
      )
    )
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

class Client {
  cookies = new Map();
  capture(response) {
    const values =
      response.headers.getSetCookie?.() ??
      [response.headers.get("set-cookie")].filter(Boolean);
    for (const value of values) {
      const pair = value.split(";", 1)[0];
      const index = pair.indexOf("=");
      if (index > 0)
        this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }
  async raw(path, init = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        ...(this.cookies.size
          ? {
              cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
            }
          : {}),
      },
    });
    this.capture(response);
    return response;
  }
  async json(path, init = {}) {
    const response = await this.raw(path, init);
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        `${init.method ?? "GET"} ${path} -> ${response.status} ${data.error ?? data.message ?? "UNKNOWN"}`,
      );
    return data;
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
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const terminal = new Set([
  "drafted",
  "partial",
  "manual_review",
  "failed",
  "cancelled",
  "awaiting_upload",
]);
async function waitJob(client, id) {
  const deadline = Date.now() + 120_000;
  let job;
  while (Date.now() < deadline) {
    job = (await client.json(`/api/content-jobs/${id}`)).job;
    if (terminal.has(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`job timeout: ${job?.status ?? "unknown"}`);
}

const admin = new Client();
const login = await admin.mutate("/api/auth/login", "POST", {
  email: env.BOOTSTRAP_ADMIN_EMAIL,
  password: env.SMOKE_ADMIN_PERMANENT_PASSWORD ?? env.BOOTSTRAP_ADMIN_PASSWORD,
});
if (login.user.mustChangePassword)
  await admin.mutate("/api/auth/change-password", "POST", {
    currentPassword:
      env.SMOKE_ADMIN_PERMANENT_PASSWORD ?? env.BOOTSTRAP_ADMIN_PASSWORD,
    newPassword:
      env.SMOKE_ADMIN_PERMANENT_PASSWORD ?? `Stage9!Admin-${randomUUID()}`,
  });

const created = await admin.mutate("/api/content-jobs", "POST", {
  operationId: randomUUID(),
  topic: "【第9阶段】企业内容运营怎样建立证据与人工复核边界",
  title: "企业内容运营的证据与复核边界",
  readerMode: "general",
  sourceRefs: [],
  attachmentIds: [],
  targets: ["official_site", "wechat", "xiaohongshu"],
  imageMode: "generated",
  remarks: "隔离回归，只创建 Mock 草稿，不正式发布",
  confirmDraft: true,
});
const job = await waitJob(admin, created.job.id);
const xhs = job.targets.find((item) => item.target === "xiaohongshu");
assert(xhs?.uploadTask?.id, "小红书上传任务未生成");
assert(xhs.status === "waiting_for_uploader", "小红书未进入等待扩展状态");
assert(
  job.targets.find((item) => item.target === "official_site")?.status ===
    "drafted",
  "官网 Mock 草稿未完成",
);
assert(
  job.targets.find((item) => item.target === "wechat")?.status === "drafted",
  "公众号 Mock 草稿未完成",
);

const issued = await admin.mutate("/api/extension-tokens", "POST", {
  name: "第9阶段隔离扩展",
});
const auth = { authorization: `Bearer ${issued.token.token}` };
assert(
  (await admin.json("/api/extensions/xiaohongshu/status", { headers: auth }))
    .capabilities.formalPublish === false,
  "扩展协议错误允许正式发布",
);
const claimed = await admin.json("/api/extensions/xiaohongshu/tasks/claim", {
  method: "POST",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({ taskId: xhs.uploadTask.id }),
});
assert(claimed.task?.id === xhs.uploadTask.id, "指定小红书任务领取失败");
await admin.json(
  `/api/extensions/xiaohongshu/tasks/${xhs.uploadTask.id}/heartbeat`,
  {
    method: "POST",
    headers: auth,
  },
);
const invalidResult = await admin.raw(
  `/api/extensions/xiaohongshu/tasks/${xhs.uploadTask.id}/result`,
  {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ status: "drafted" }),
  },
);
assert(invalidResult.status === 400, "缺少草稿成功信号仍被接受");
await admin.json(
  `/api/extensions/xiaohongshu/tasks/${xhs.uploadTask.id}/result`,
  {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({
      status: "drafted",
      draftSaved: true,
      saveSignal: "isolated-regression-draft-saved",
      platformDraftId: `mock-xhs-${randomUUID()}`,
    }),
  },
);
const drafted = (await admin.json(`/api/content-jobs/${job.id}`)).job;
assert(drafted.status === "drafted", "小红书回报后父任务未完成");

// New content created from the operator UI must stop before every external
// draft write. Approving each channel then resumes only that target.
const gatedCreated = await admin.mutate("/api/content-jobs", "POST", {
  operationId: randomUUID(),
  topic: "【复核门禁回归】企业如何安全使用 AI 内容助手",
  title: "AI 内容助手上线前的三项检查",
  readerMode: "general",
  sourceRefs: [],
  attachmentIds: [],
  targets: ["official_site", "wechat", "xiaohongshu"],
  imageMode: "generated",
  remarks: "隔离回归：三渠道先复核，通过后只保存 Mock 草稿",
  confirmDraft: true,
  requireReviewBeforeDraft: true,
});
const gated = await waitJob(admin, gatedCreated.job.id);
assert(gated.status === "manual_review", "新任务未停在人工复核");
assert(
  gated.targets.every((target) => target.status === "manual_review"),
  "有渠道在复核前提前写入了草稿",
);
assert(
  gated.targets.every((target) => !target.externalDraftId),
  "复核前不应存在外部草稿 ID",
);
const gatedPending = (
  await admin.json("/api/manual-reviews?status=pending")
).reviews.filter((item) => item.contentJobId === gated.id);
assert(gatedPending.length === 3, "三渠道复核单未完整生成");
const reviewedXhsTitle = "复核后的多账号发布标题";
for (const target of ["official_site", "wechat", "xiaohongshu"]) {
  const review = gatedPending.find((item) => item.target === target);
  assert(review?.id, `${target} 复核单缺失`);
  const article = {
    ...gated.result.channelArticles[target],
    ...(target === "xiaohongshu" ? { title: reviewedXhsTitle } : {}),
  };
  assert(article?.title, `${target} 待复核文章缺失`);
  const existingImages = (
    gated.result.channelArtifacts?.[target]?.assets ?? []
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
  assert(preview.html?.length > 300, `${target} 复核预览未生成`);
  await admin.mutate(`/api/manual-reviews/${review.id}/decision`, "POST", {
    decision: "approve_content",
    note: `隔离回归：${target} 内容已核对`,
    artifactRevision: revision,
  });
}
let gatedAfterReview;
for (let attempt = 0; attempt < 240; attempt += 1) {
  gatedAfterReview = (await admin.json(`/api/content-jobs/${gated.id}`)).job;
  if (
    gatedAfterReview.targets.find((target) => target.target === "official_site")
      ?.status === "drafted" &&
    gatedAfterReview.targets.find((target) => target.target === "wechat")
      ?.status === "drafted" &&
    gatedAfterReview.targets.find((target) => target.target === "xiaohongshu")
      ?.status === "waiting_for_uploader"
  )
    break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
assert(
  gatedAfterReview.targets.find((target) => target.target === "official_site")
    ?.externalDraftId,
  "官网复核通过后未创建 Mock 草稿",
);
assert(
  gatedAfterReview.targets.find((target) => target.target === "wechat")
    ?.externalDraftId,
  "公众号复核通过后未创建 Mock 草稿",
);
const gatedXhs = gatedAfterReview.targets.find(
  (target) => target.target === "xiaohongshu",
);
assert(
  gatedXhs?.status === "waiting_for_uploader" && gatedXhs.uploadTask?.id,
  `小红书复核通过后未生成上传包：${JSON.stringify(gatedXhs)}`,
);
const gatedToken = await admin.mutate("/api/extension-tokens", "POST", {
  name: "复核门禁回归扩展",
});
const gatedAuth = { authorization: `Bearer ${gatedToken.token.token}` };
await admin.json("/api/extensions/xiaohongshu/tasks/claim", {
  method: "POST",
  headers: { ...gatedAuth, "content-type": "application/json" },
  body: JSON.stringify({ taskId: gatedXhs.uploadTask.id }),
});
await admin.json(
  `/api/extensions/xiaohongshu/tasks/${gatedXhs.uploadTask.id}/result`,
  {
    method: "POST",
    headers: { ...gatedAuth, "content-type": "application/json" },
    body: JSON.stringify({
      status: "drafted",
      draftSaved: true,
      saveSignal: "review-gated-isolated-draft-saved",
      platformDraftId: `mock-xhs-review-${randomUUID()}`,
    }),
  },
);
const gatedDone = (await admin.json(`/api/content-jobs/${gated.id}`)).job;
assert(gatedDone.status === "drafted", "三渠道复核后父任务未完成");
assert(
  gatedDone.targets.every((target) => target.status === "drafted"),
  "三渠道复核后未全部进入 drafted",
);
const reviewedDeliveryOption = (
  await admin.json("/api/delivery-content-options")
).contents.find(
  (item) =>
    item.contentJobId === gatedDone.id && item.channel === "xiaohongshu",
);
assert(
  reviewedDeliveryOption?.title === reviewedXhsTitle &&
    gatedDone.title !== reviewedDeliveryOption.title,
  `多账号投放没有使用复核后的渠道标题：${JSON.stringify({ expected: reviewedXhsTitle, option: reviewedDeliveryOption?.title, job: gatedDone.title })}`,
);

// Multi-account delivery is a separate layer: it reuses the immutable,
// approved browser artifact without changing the original target state.
const secondToken = await admin.mutate("/api/extension-tokens", "POST", {
  name: "多账号隔离扩展 B",
});
const secondAuth = { authorization: `Bearer ${secondToken.token.token}` };
const firstAccount = await admin.json(
  "/api/extensions/xiaohongshu/accounts/register",
  {
    method: "POST",
    headers: { ...gatedAuth, "content-type": "application/json" },
    body: JSON.stringify({
      clientAccountKey: "isolated-account-a",
      displayName: "隔离账号 A",
      profileUrl: "https://creator.xiaohongshu.com/profile/account-a",
    }),
  },
);
const secondAccount = await admin.json(
  "/api/extensions/xiaohongshu/accounts/register",
  {
    method: "POST",
    headers: { ...secondAuth, "content-type": "application/json" },
    body: JSON.stringify({
      clientAccountKey: "isolated-account-b",
      displayName: "隔离账号 B",
      profileUrl: "https://creator.xiaohongshu.com/profile/account-b",
    }),
  },
);
const draftBatchOperationId = randomUUID();
const draftBatch = await admin.mutate("/api/delivery-batches", "POST", {
  operationId: draftBatchOperationId,
  contentJobId: gatedDone.id,
  channel: "xiaohongshu",
  mode: "draft",
  accountIds: [firstAccount.account.id, secondAccount.account.id],
});
assert(draftBatch.accountCount === 2, "多账号草稿批次未拆成两个账号任务");
const idempotentBatch = await admin.mutate("/api/delivery-batches", "POST", {
  operationId: draftBatchOperationId,
  contentJobId: gatedDone.id,
  channel: "xiaohongshu",
  mode: "draft",
  accountIds: [firstAccount.account.id, secondAccount.account.id],
});
assert(idempotentBatch.idempotent === true, "投放批次 operationId 未实现幂等");
await admin.json("/api/extensions/xiaohongshu/accounts/register", {
  method: "POST",
  headers: { ...gatedAuth, "content-type": "application/json" },
  body: JSON.stringify({
    clientAccountKey: "isolated-account-a-switched",
    displayName: "隔离账号 A（已切换）",
    profileUrl: "https://creator.xiaohongshu.com/profile/account-a-switched",
  }),
});
const firstDelivery = await admin.json("/api/extensions/deliveries/claim", {
  method: "POST",
  headers: { ...gatedAuth, "content-type": "application/json" },
  body: "{}",
});
assert(
  firstDelivery.task?.targetAccount?.id === firstAccount.account.id &&
    firstDelivery.task?.targetAccount?.key === "isolated-account-a",
  "投放项没有冻结批次创建时的账号标识快照",
);
const secondDelivery = await admin.json("/api/extensions/deliveries/claim", {
  method: "POST",
  headers: { ...secondAuth, "content-type": "application/json" },
  body: "{}",
});
assert(
  secondDelivery.task?.targetAccount?.id === secondAccount.account.id,
  "第二个扩展没有领取到自己的账号任务",
);
await admin.json(`/api/extensions/deliveries/${firstDelivery.task.id}/result`, {
  method: "POST",
  headers: { ...gatedAuth, "content-type": "application/json" },
  body: JSON.stringify({
    status: "drafted",
    draftSaved: true,
    saveSignal: "isolated multi-account draft saved",
  }),
});
await admin.json(
  `/api/extensions/deliveries/${secondDelivery.task.id}/result`,
  {
    method: "POST",
    headers: { ...secondAuth, "content-type": "application/json" },
    body: JSON.stringify({
      status: "failed",
      errorCode: "ISOLATED_ACCOUNT_FAILURE",
      message: "isolated account failure",
    }),
  },
);
const partialBatch = (await admin.json("/api/delivery-batches")).batches.find(
  (batch) => batch.id === draftBatch.batchId,
);
assert(
  partialBatch?.status === "partial" &&
    partialBatch.items.some((item) => item.status === "drafted") &&
    partialBatch.items.some((item) => item.status === "failed"),
  "单账号失败错误影响了整个多账号批次",
);

const revokedConnectionBatch = await admin.mutate(
  "/api/delivery-batches",
  "POST",
  {
    operationId: randomUUID(),
    contentJobId: gatedDone.id,
    channel: "xiaohongshu",
    mode: "draft",
    accountIds: [secondAccount.account.id],
  },
);
await admin.mutate(`/api/extension-tokens/${secondToken.token.id}`, "DELETE");
const cancelledBatch = (await admin.json("/api/delivery-batches")).batches.find(
  (batch) => batch.id === revokedConnectionBatch.batchId,
);
assert(
  cancelledBatch?.status === "failed" &&
    cancelledBatch.items[0]?.status === "cancelled",
  "扩展连接撤销后排队投放项没有安全取消",
);
const disabledAccount = (
  await admin.json("/api/channel-accounts")
).accounts.find((account) => account.id === secondAccount.account.id);
assert(disabledAccount?.status === "disabled", "扩展连接撤销后账号仍显示可用");

const rejectedPublish = await admin.raw("/api/delivery-batches", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-csrf-token": await admin.csrf(),
  },
  body: JSON.stringify({
    operationId: randomUUID(),
    contentJobId: gatedDone.id,
    channel: "xiaohongshu",
    mode: "publish",
    accountIds: [firstAccount.account.id],
    reviewConfirmed: true,
    confirmTitle: "错误标题",
  }),
});
assert(rejectedPublish.status === 409, "正式发布未核对标题仍被授权");
const publishBatch = await admin.mutate("/api/delivery-batches", "POST", {
  operationId: randomUUID(),
  contentJobId: gatedDone.id,
  channel: "xiaohongshu",
  mode: "publish",
  accountIds: [firstAccount.account.id],
  reviewConfirmed: true,
  confirmTitle: reviewedDeliveryOption.title,
});
const publishDelivery = await admin.json("/api/extensions/deliveries/claim", {
  method: "POST",
  headers: { ...gatedAuth, "content-type": "application/json" },
  body: "{}",
});
assert(
  publishDelivery.task?.batchId === publishBatch.batchId &&
    publishDelivery.task.payload?.safety?.formalPublishAuthorized === true &&
    publishDelivery.task.payload?.reviewedContentFingerprint ===
      publishDelivery.task.contentFingerprint,
  "正式发布任务缺少审核版本和一次性授权绑定",
);
await admin.json(
  `/api/extensions/deliveries/${publishDelivery.task.id}/result`,
  {
    method: "POST",
    headers: { ...gatedAuth, "content-type": "application/json" },
    body: JSON.stringify({
      status: "published",
      published: true,
      successSignal: "isolated publish success",
    }),
  },
);
const publishedBatch = (await admin.json("/api/delivery-batches")).batches.find(
  (batch) => batch.id === publishBatch.batchId,
);
assert(publishedBatch?.status === "completed", "正式发布批次未完成");

// Reuse the finished mock artifact to exercise the production manual-review
// workflow without calling an external channel. A missing-image condition is
// represented exactly as the worker does in production.
await admin.mutate(`/api/extension-tokens/${issued.token.id}`, "DELETE");
const revoked = await admin.raw("/api/extensions/xiaohongshu/status", {
  headers: auth,
});
assert(revoked.status === 401, "已撤销扩展仍能访问");

// The test database is isolated, so a targeted state transition is safe and
// lets the public API create the same pending review record as production.
function isolatedSql(sql) {
  const container = process.env.SMOKE_POSTGRES_CONTAINER;
  if (!container) throw new Error("SMOKE_POSTGRES_CONTAINER_REQUIRED");
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      process.env.SMOKE_POSTGRES_USER ?? "geekdance_ops",
      "-d",
      process.env.SMOKE_POSTGRES_DB ?? "geekdance_ops",
      "-c",
      sql,
    ],
    { encoding: "utf8" },
  ).trim();
}
const reviewTargetId = isolatedSql(
  `SELECT id FROM job_targets WHERE job_id = '${drafted.id}' AND target = 'wechat'`,
);
assert(reviewTargetId, "公众号渠道目标不存在");
isolatedSql(
  `UPDATE job_targets SET status = 'manual_review', error_code = 'NO_RELEVANT_GEEKHOME_MATERIAL', updated_at = NOW()
   WHERE id = '${reviewTargetId}'`,
);
isolatedSql(
  `UPDATE content_jobs
   SET status = 'manual_review',
       result = jsonb_set(
         jsonb_set(result, '{contentStatus}', '"blocked"'::jsonb, true),
         '{manualReviewReason}',
         '"没有达到相关性阈值的 GeekHome 素材"'::jsonb,
         true
       ),
       updated_at = NOW()
   WHERE id = '${drafted.id}'`,
);
const pending = (
  await admin.json("/api/manual-reviews?status=pending")
).reviews.find(
  (item) => item.contentJobId === drafted.id && item.target === "wechat",
);
assert(pending?.id, "人工复核记录未生成");
const revision = {
  article: drafted.result.channelArticles.wechat,
  images: [],
};
const preview = await admin.mutate(
  `/api/manual-reviews/${pending.id}/preview`,
  "POST",
  revision,
);
assert(preview.html?.length > 500, "无配图复核预览未生成");
await admin.mutate(`/api/manual-reviews/${pending.id}/decision`, "POST", {
  decision: "approve_content",
  note: "隔离回归：正文事实与排版已核对，无需补图，只创建公众号 Mock 草稿。",
  artifactRevision: revision,
});
const reviewed = await waitJob(admin, drafted.id);
assert(
  reviewed.targets.find((item) => item.target === "wechat")?.status ===
    "drafted",
  "人工复核通过后公众号草稿未恢复",
);
const resolved = (
  await admin.json("/api/manual-reviews?status=resolved")
).reviews.find((item) => item.id === pending.id);
assert(
  resolved?.status === "approved" && resolved.revisionApplied,
  "人工复核记录未保存修订结果",
);

console.log(
  JSON.stringify({
    ok: true,
    verified: [
      "three_channel_draft_state_machine",
      "xiaohongshu_targeted_claim",
      "xiaohongshu_heartbeat",
      "draft_success_signal_required",
      "formal_publish_forbidden",
      "parent_job_recomputed_after_extension_result",
      "all_channels_review_before_draft",
      "official_review_then_draft",
      "wechat_review_then_draft",
      "xiaohongshu_review_then_upload_package",
      "xiaohongshu_review_then_draft_signal",
      "extension_revocation",
      "manual_review_without_images",
      "manual_review_preview",
      "manual_review_approved_target_only",
      "multi_account_token_isolation",
      "multi_account_operation_idempotency",
      "multi_account_partial_failure_isolation",
      "multi_account_account_snapshot",
      "extension_revoke_cancels_queued_deliveries",
      "formal_publish_confirmation_gate",
      "formal_publish_fingerprint_authorization",
      "reviewed_channel_title_confirmation",
    ],
  }),
);
