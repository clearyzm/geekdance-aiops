import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { browserDraftChannelSchema, channelLabels } from "@geekdance/shared";
import { downloadRemoteImage } from "@geekdance/channel-adapters";
import { config } from "./config.js";
import { db } from "./database.js";
import {
  authenticate,
  authenticateExtension,
  requireCsrf,
} from "./security.js";
import {
  deliveryResultMatchesMode,
  formalPublishConfirmed,
  summarizeDeliveryItems,
} from "./multi-account-delivery-policy.js";

const deliveryModeSchema = z.enum(["draft", "publish"]);
const deliveryStatusSchema = z.enum([
  "filled",
  "drafted",
  "published",
  "failed",
  "ambiguous",
  "manual_review",
]);

function accountView(row: Record<string, any>) {
  return {
    id: row.id,
    channel: row.channel,
    displayName: row.display_name,
    profileUrl: row.profile_url,
    status: row.effective_status ?? row.status,
    online: row.online === true,
    owner: { id: row.owner_user_id, name: row.owner_name },
    deviceName: row.device_name,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  };
}

function batchView(
  row: Record<string, any>,
  items: Record<string, any>[] = [],
) {
  return {
    id: row.id,
    operationId: row.operation_id,
    contentJobId: row.content_job_id,
    title: row.title,
    channel: row.channel,
    channelName: channelLabels[row.channel as keyof typeof channelLabels],
    mode: row.mode,
    status: row.status,
    contentFingerprint: row.content_fingerprint,
    createdBy: { id: row.created_by, name: row.created_by_name },
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: items.map((item) => ({
      id: item.id,
      accountId: item.account_id,
      accountName: item.account_name,
      ownerName: item.owner_name,
      status: item.status,
      errorCode: item.error_code,
      platformContentId: item.platform_content_id,
      platformUrl: item.platform_url,
      result: item.result,
      updatedAt: item.updated_at,
    })),
  };
}

export async function recomputeDeliveryBatch(batchId: string) {
  const items = await db.query(
    "SELECT status FROM browser_delivery_items WHERE batch_id = $1",
    [batchId],
  );
  const states = items.rows.map((row) => String(row.status));
  if (!states.length) return;
  const status = summarizeDeliveryItems(states);
  await db.query(
    "UPDATE browser_delivery_batches SET status = $1, updated_at = NOW() WHERE id = $2",
    [status, batchId],
  );
}

export async function registerMultiAccountDeliveryRoutes(app: FastifyInstance) {
  app.get(
    "/api/channel-accounts",
    { preHandler: [authenticate] },
    async (request) => {
      const result = await db.query(
        `SELECT a.*, u.display_name AS owner_name, et.name AS device_name,
                CASE WHEN a.status = 'active' AND et.revoked_at IS NULL
                       AND et.expires_at > NOW() THEN 'active' ELSE 'disabled' END AS effective_status,
                (a.status = 'active' AND et.revoked_at IS NULL AND et.expires_at > NOW()
                  AND a.last_seen_at > NOW() - INTERVAL '3 minutes') AS online
         FROM browser_channel_accounts a
         JOIN users u ON u.id = a.owner_user_id
         JOIN extension_tokens et ON et.id = a.extension_token_id
         WHERE ($1::text = 'admin' OR a.status = 'active' OR a.owner_user_id = $2)
         ORDER BY a.channel, a.status, a.last_seen_at DESC`,
        [request.sessionUser!.role, request.sessionUser!.id],
      );
      return { accounts: result.rows.map(accountView) };
    },
  );

  app.delete(
    "/api/channel-accounts/:accountId",
    { preHandler: [authenticate, requireCsrf] },
    async (request, reply) => {
      const params = z
        .object({ accountId: z.string().uuid() })
        .safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ error: "INVALID_ACCOUNT_ID" });
      const client = await db.connect();
      const affectedBatches = new Set<string>();
      try {
        await client.query("BEGIN");
        const result = await client.query(
          `UPDATE browser_channel_accounts SET status = 'disabled', updated_at = NOW()
           WHERE id = $1 AND ($2::text = 'admin' OR owner_user_id = $3)
           RETURNING id`,
          [
            params.data.accountId,
            request.sessionUser!.role,
            request.sessionUser!.id,
          ],
        );
        if (!result.rowCount) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "NOT_FOUND" });
        }
        const cancelled = await client.query(
          `UPDATE browser_delivery_items SET status = 'cancelled',
             error_code = 'ACCOUNT_DISABLED', updated_at = NOW()
           WHERE account_id = $1 AND status = 'waiting_for_extension'
           RETURNING batch_id`,
          [params.data.accountId],
        );
        for (const item of cancelled.rows)
          affectedBatches.add(String(item.batch_id));
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      for (const batchId of affectedBatches)
        await recomputeDeliveryBatch(batchId);
      return { ok: true };
    },
  );

  app.get(
    "/api/delivery-content-options",
    { preHandler: [authenticate] },
    async (request) => {
      const result = await db.query(
        `SELECT cj.id,
           COALESCE(NULLIF(xt.payload #>> '{note,title}', ''),
                    NULLIF(xt.payload #>> '{article,title}', ''),
                    NULLIF(cj.title, ''), cj.topic) AS reviewed_title,
           cj.topic, cj.updated_at, jt.target,
           xt.content_fingerprint, mr.resolved_at AS reviewed_at
         FROM content_jobs cj
         JOIN job_targets jt ON jt.job_id = cj.id
         JOIN xiaohongshu_upload_tasks xt ON xt.target_id = jt.id
         JOIN LATERAL (
           SELECT status, resolved_at FROM manual_reviews
           WHERE target_id = jt.id AND category = 'content_quality'
           ORDER BY created_at DESC LIMIT 1
         ) mr ON mr.status = 'approved'
         WHERE cj.deleted_at IS NULL
           AND jt.target IN ('xiaohongshu', 'zhihu', 'toutiao', 'baijiahao', 'linkedin')
           AND ($1::text = 'admin' OR cj.created_by = $2)
         ORDER BY cj.updated_at DESC, jt.target`,
        [request.sessionUser!.role, request.sessionUser!.id],
      );
      return {
        contents: result.rows.map((row) => ({
          contentJobId: row.id,
          title: row.reviewed_title,
          topic: row.topic,
          channel: row.target,
          contentFingerprint: row.content_fingerprint,
          reviewedAt: row.reviewed_at,
          updatedAt: row.updated_at,
        })),
      };
    },
  );

  app.get(
    "/api/delivery-batches",
    { preHandler: [authenticate] },
    async (request) => {
      const batches = await db.query(
        `SELECT b.*, b.reviewed_title AS title, creator.display_name AS created_by_name
         FROM browser_delivery_batches b
         JOIN content_jobs cj ON cj.id = b.content_job_id
         JOIN users creator ON creator.id = b.created_by
         WHERE ($1::text = 'admin' OR b.created_by = $2)
         ORDER BY b.created_at DESC LIMIT 100`,
        [request.sessionUser!.role, request.sessionUser!.id],
      );
      const ids = batches.rows.map((row) => row.id);
      const items = ids.length
        ? await db.query(
            `SELECT i.*, i.target_account_name AS account_name, u.display_name AS owner_name
             FROM browser_delivery_items i
             JOIN browser_channel_accounts a ON a.id = i.account_id
             JOIN users u ON u.id = a.owner_user_id
             WHERE i.batch_id = ANY($1::uuid[]) ORDER BY i.created_at`,
            [ids],
          )
        : { rows: [] as Record<string, any>[] };
      return {
        batches: batches.rows.map((batch) =>
          batchView(
            batch,
            items.rows.filter((item) => item.batch_id === batch.id),
          ),
        ),
      };
    },
  );

  app.post(
    "/api/delivery-batches",
    { preHandler: [authenticate, requireCsrf] },
    async (request, reply) => {
      const parsed = z
        .object({
          operationId: z.string().uuid(),
          contentJobId: z.string().uuid(),
          channel: browserDraftChannelSchema,
          mode: deliveryModeSchema.default("draft"),
          accountIds: z.array(z.string().uuid()).min(1).max(50),
          reviewConfirmed: z.boolean().optional(),
          confirmTitle: z.string().trim().max(300).optional(),
        })
        .safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ error: "INVALID_DELIVERY_BATCH" });
      const input = parsed.data;
      const duplicate = await db.query(
        "SELECT id, created_by FROM browser_delivery_batches WHERE operation_id = $1",
        [input.operationId],
      );
      if (duplicate.rowCount) {
        if (
          request.sessionUser!.role !== "admin" &&
          duplicate.rows[0].created_by !== request.sessionUser!.id
        )
          return reply.code(409).send({ error: "CONFLICT" });
        const existing = await db.query(
          `SELECT b.*, b.reviewed_title AS title, u.display_name AS created_by_name
           FROM browser_delivery_batches b JOIN content_jobs cj ON cj.id = b.content_job_id
           JOIN users u ON u.id = b.created_by WHERE b.id = $1`,
          [duplicate.rows[0].id],
        );
        const items = await db.query(
          `SELECT i.*, i.target_account_name AS account_name, u.display_name AS owner_name
           FROM browser_delivery_items i JOIN browser_channel_accounts a ON a.id = i.account_id
           JOIN users u ON u.id = a.owner_user_id WHERE i.batch_id = $1`,
          [duplicate.rows[0].id],
        );
        return {
          batch: batchView(existing.rows[0], items.rows),
          idempotent: true,
        };
      }
      const source = await db.query(
        `SELECT cj.id AS content_job_id, cj.title, cj.topic, cj.created_by,
                jt.id AS target_id, xt.payload, xt.content_fingerprint
         FROM content_jobs cj
         JOIN job_targets jt ON jt.job_id = cj.id AND jt.target = $2
         JOIN xiaohongshu_upload_tasks xt ON xt.target_id = jt.id
         WHERE cj.id = $1 AND cj.deleted_at IS NULL
           AND ($3::text = 'admin' OR cj.created_by = $4)
           AND (
             SELECT mr.status FROM manual_reviews mr
             WHERE mr.target_id = jt.id AND mr.category = 'content_quality'
             ORDER BY mr.created_at DESC LIMIT 1
           ) = 'approved'`,
        [
          input.contentJobId,
          input.channel,
          request.sessionUser!.role,
          request.sessionUser!.id,
        ],
      );
      const row = source.rows[0];
      if (!row)
        return reply.code(409).send({
          error: "REVIEWED_DELIVERY_CONTENT_NOT_READY",
          message: "该渠道没有已通过人工复核的可投放版本",
        });
      const title = String(
        row.payload?.note?.title ||
          row.payload?.article?.title ||
          row.title ||
          row.topic ||
          "",
      ).trim();
      if (
        input.mode === "publish" &&
        !formalPublishConfirmed({
          reviewConfirmed: input.reviewConfirmed,
          confirmTitle: input.confirmTitle,
          reviewedTitle: title,
        })
      )
        return reply.code(409).send({
          error: "FORMAL_PUBLISH_CONFIRMATION_REQUIRED",
          message: "正式发布前必须确认文章与配图，并完整输入文章标题",
        });
      const accounts = await db.query(
        `SELECT a.id, a.extension_token_id, a.client_account_key, a.display_name
         FROM browser_channel_accounts a
         JOIN extension_tokens et ON et.id = a.extension_token_id
         WHERE a.id = ANY($1::uuid[]) AND a.channel = $2 AND a.status = 'active'
           AND et.revoked_at IS NULL AND et.expires_at > NOW()`,
        [[...new Set(input.accountIds)], input.channel],
      );
      if (accounts.rowCount !== new Set(input.accountIds).size)
        return reply.code(409).send({
          error: "DELIVERY_ACCOUNT_UNAVAILABLE",
          message: "部分账号已停用、过期或不属于所选渠道，请刷新账号列表",
        });
      const batchId = randomUUID();
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO browser_delivery_batches
           (id, operation_id, content_job_id, target_id, channel, mode,
            reviewed_title, content_fingerprint, created_by, confirmed_by, confirmed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            batchId,
            input.operationId,
            row.content_job_id,
            row.target_id,
            input.channel,
            input.mode,
            title,
            row.content_fingerprint,
            request.sessionUser!.id,
            input.mode === "publish" ? request.sessionUser!.id : null,
            input.mode === "publish" ? new Date() : null,
          ],
        );
        for (const account of accounts.rows) {
          const itemId = randomUUID();
          const payload = {
            ...row.payload,
            deliveryMode: input.mode,
            targetAccountId: account.id,
            reviewedContentFingerprint: row.content_fingerprint,
            safety:
              input.mode === "draft"
                ? { draftOnly: true, formalPublishForbidden: true }
                : {
                    draftOnly: false,
                    formalPublishAuthorized: true,
                    authorizationBatchId: batchId,
                    authorizationItemId: itemId,
                  },
          };
          await client.query(
            `INSERT INTO browser_delivery_items
             (id, batch_id, account_id, target_account_key, target_account_name,
              operation_id, payload)
             VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
            [
              itemId,
              batchId,
              account.id,
              account.client_account_key,
              account.display_name,
              randomUUID(),
              JSON.stringify(payload),
            ],
          );
        }
        await client.query(
          `INSERT INTO audit_logs
           (id, actor_id, action, resource_type, resource_id, result, metadata)
           VALUES ($1,$2,$3,'browser_delivery_batch',$4,'success',$5::jsonb)`,
          [
            randomUUID(),
            request.sessionUser!.id,
            input.mode === "publish"
              ? "delivery.publish.authorize"
              : "delivery.draft.create",
            batchId,
            JSON.stringify({
              channel: input.channel,
              accountIds: accounts.rows.map((account) => account.id),
              contentFingerprint: row.content_fingerprint,
            }),
          ],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return reply.code(201).send({ batchId, accountCount: accounts.rowCount });
    },
  );

  app.post(
    "/api/extensions/:channel/accounts/register",
    { preHandler: [authenticateExtension] },
    async (request, reply) => {
      const parsed = z
        .object({
          channel: browserDraftChannelSchema,
          clientAccountKey: z.string().trim().min(8).max(200),
          displayName: z.string().trim().min(1).max(120),
          profileUrl: z.string().url().max(2_048).optional(),
          metadata: z.record(z.unknown()).optional(),
        })
        .safeParse({
          ...(request.params as object),
          ...(request.body as object),
        });
      if (!parsed.success)
        return reply.code(400).send({ error: "INVALID_CHANNEL_ACCOUNT" });
      const id = randomUUID();
      const result = await db.query(
        `INSERT INTO browser_channel_accounts
         (id, channel, extension_token_id, owner_user_id, client_account_key,
          display_name, profile_url, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         ON CONFLICT (extension_token_id, channel) DO UPDATE SET
           client_account_key = EXCLUDED.client_account_key,
           display_name = EXCLUDED.display_name,
           profile_url = EXCLUDED.profile_url,
           metadata = EXCLUDED.metadata,
           status = 'active', last_seen_at = NOW(), updated_at = NOW()
         RETURNING *`,
        [
          id,
          parsed.data.channel,
          request.extensionAuth!.tokenId,
          request.extensionAuth!.user.id,
          parsed.data.clientAccountKey,
          parsed.data.displayName,
          parsed.data.profileUrl ?? null,
          JSON.stringify(parsed.data.metadata ?? {}),
        ],
      );
      return { account: accountView(result.rows[0]) };
    },
  );

  app.post(
    "/api/extensions/deliveries/claim",
    { preHandler: [authenticateExtension] },
    async (request) => {
      const tokenId = request.extensionAuth!.tokenId;
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `UPDATE browser_channel_accounts SET last_seen_at = NOW(), updated_at = NOW()
           WHERE extension_token_id = $1 AND status = 'active'`,
          [tokenId],
        );
        const unavailable = await client.query(
          `UPDATE browser_delivery_items i SET status = 'cancelled',
             error_code = 'ACCOUNT_CONNECTION_UNAVAILABLE', updated_at = NOW()
           FROM browser_channel_accounts a, extension_tokens et
           WHERE i.account_id = a.id AND a.extension_token_id = et.id
             AND i.status = 'waiting_for_extension'
             AND (a.status <> 'active' OR et.revoked_at IS NOT NULL OR et.expires_at <= NOW())
           RETURNING i.batch_id`,
        );
        const expired = await client.query(
          `UPDATE browser_delivery_items SET status = 'ambiguous',
             error_code = 'DELIVERY_CLAIM_EXPIRED', claim_expires_at = NULL,
             updated_at = NOW()
           WHERE status = 'uploading' AND claim_expires_at < NOW()
           RETURNING batch_id`,
        );
        const next = await client.query(
          `SELECT i.*, b.channel, b.mode, b.content_fingerprint
           FROM browser_delivery_items i
           JOIN browser_delivery_batches b ON b.id = i.batch_id
           JOIN browser_channel_accounts a ON a.id = i.account_id
           WHERE i.status = 'waiting_for_extension' AND a.status = 'active'
             AND a.extension_token_id = $1
           ORDER BY i.created_at FOR UPDATE OF i SKIP LOCKED LIMIT 1`,
          [tokenId],
        );
        const row = next.rows[0];
        const affectedBatchIds = new Set(
          [...unavailable.rows, ...expired.rows].map((item) =>
            String(item.batch_id),
          ),
        );
        if (!row) {
          await client.query("COMMIT");
          for (const id of affectedBatchIds) await recomputeDeliveryBatch(id);
          return { task: null };
        }
        const claimed = await client.query(
          `UPDATE browser_delivery_items SET status = 'uploading',
             claimed_by_token_id = $1, claim_expires_at = NOW() + INTERVAL '5 minutes',
             updated_at = NOW() WHERE id = $2 RETURNING *`,
          [tokenId, row.id],
        );
        await client.query(
          "UPDATE browser_delivery_batches SET status = 'running', updated_at = NOW() WHERE id = $1",
          [row.batch_id],
        );
        await client.query("COMMIT");
        for (const id of affectedBatchIds) await recomputeDeliveryBatch(id);
        return {
          task: {
            id: row.id,
            batchId: row.batch_id,
            channel: row.channel,
            deliveryMode: row.mode,
            contentFingerprint: row.content_fingerprint,
            targetAccount: {
              id: row.account_id,
              key: row.target_account_key,
              displayName: row.target_account_name,
            },
            payload: claimed.rows[0].payload,
          },
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post(
    "/api/extensions/deliveries/:itemId/heartbeat",
    { preHandler: [authenticateExtension] },
    async (request, reply) => {
      const params = z
        .object({ itemId: z.string().uuid() })
        .safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ error: "INVALID_DELIVERY_ITEM" });
      const result = await db.query(
        `UPDATE browser_delivery_items SET claim_expires_at = NOW() + INTERVAL '5 minutes', updated_at = NOW()
         WHERE id = $1 AND claimed_by_token_id = $2 AND status = 'uploading'
           AND claim_expires_at >= NOW() RETURNING id`,
        [params.data.itemId, request.extensionAuth!.tokenId],
      );
      if (!result.rowCount)
        return reply.code(409).send({ error: "DELIVERY_CLAIM_LOST" });
      return { ok: true };
    },
  );

  app.get(
    "/api/extensions/deliveries/:itemId/images/:imageIndex",
    { preHandler: [authenticateExtension] },
    async (request, reply) => {
      const params = z
        .object({
          itemId: z.string().uuid(),
          imageIndex: z.coerce.number().int().min(0).max(19),
        })
        .safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ error: "INVALID_IMAGE_REQUEST" });
      const result = await db.query(
        `SELECT payload FROM browser_delivery_items
         WHERE id = $1 AND claimed_by_token_id = $2 AND status = 'uploading'
           AND claim_expires_at >= NOW()`,
        [params.data.itemId, request.extensionAuth!.tokenId],
      );
      const image = result.rows[0]?.payload?.images?.[params.data.imageIndex];
      if (!image || typeof image.url !== "string")
        return reply.code(404).send({ error: "DELIVERY_IMAGE_NOT_FOUND" });
      const allowedHosts = config.XIAOHONGSHU_IMAGE_ALLOWED_HOSTS.split(",")
        .map((host) => host.trim())
        .filter(Boolean);
      try {
        const downloaded = await downloadRemoteImage(image.url, allowedHosts);
        return reply
          .header("Cache-Control", "private, no-store")
          .header("X-Content-Type-Options", "nosniff")
          .type(downloaded.mime)
          .send(Buffer.from(downloaded.buffer));
      } catch {
        return reply.code(502).send({
          error: "DELIVERY_IMAGE_DOWNLOAD_FAILED",
          message: "运营中心无法读取该配图，请在复核页替换后重试",
        });
      }
    },
  );

  app.post(
    "/api/extensions/deliveries/:itemId/result",
    { preHandler: [authenticateExtension] },
    async (request, reply) => {
      const params = z
        .object({ itemId: z.string().uuid() })
        .safeParse(request.params);
      const parsed = z
        .object({
          status: deliveryStatusSchema,
          errorCode: z.string().trim().max(120).optional(),
          message: z.string().trim().max(1_000).optional(),
          platformContentId: z.string().trim().max(300).optional(),
          platformUrl: z.string().url().max(2_048).optional(),
          draftSaved: z.boolean().optional(),
          published: z.boolean().optional(),
          saveSignal: z.string().trim().max(300).optional(),
          successSignal: z.string().trim().max(300).optional(),
        })
        .superRefine((value, context) => {
          if (
            value.status === "drafted" &&
            (value.draftSaved !== true || !value.saveSignal)
          )
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: "缺少草稿保存成功信号",
            });
          if (
            value.status === "published" &&
            (value.published !== true || !value.successSignal)
          )
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: "缺少正式发布成功信号",
            });
        })
        .safeParse(request.body);
      if (!params.success || !parsed.success)
        return reply.code(400).send({ error: "INVALID_DELIVERY_RESULT" });
      const current = await db.query(
        `SELECT i.batch_id, b.mode FROM browser_delivery_items i
         JOIN browser_delivery_batches b ON b.id = i.batch_id
         WHERE i.id = $1 AND i.claimed_by_token_id = $2 AND i.status = 'uploading'
           AND i.claim_expires_at >= NOW()`,
        [params.data.itemId, request.extensionAuth!.tokenId],
      );
      const row = current.rows[0];
      if (!row) return reply.code(409).send({ error: "DELIVERY_CLAIM_LOST" });
      if (!deliveryResultMatchesMode(row.mode, parsed.data.status))
        return reply.code(409).send({ error: "DELIVERY_MODE_RESULT_MISMATCH" });
      await db.query(
        `UPDATE browser_delivery_items SET status = $1, result = $2::jsonb,
           error_code = $3, platform_content_id = $4, platform_url = $5,
           claim_expires_at = NULL, updated_at = NOW() WHERE id = $6`,
        [
          parsed.data.status,
          JSON.stringify(parsed.data),
          parsed.data.errorCode ?? null,
          parsed.data.platformContentId ?? null,
          parsed.data.platformUrl ?? null,
          params.data.itemId,
        ],
      );
      await recomputeDeliveryBatch(row.batch_id);
      return { ok: true };
    },
  );
}
