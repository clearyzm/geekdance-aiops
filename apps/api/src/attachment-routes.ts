import { createReadStream } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import mammoth from "mammoth";
import pdf from "pdf-parse";
import { z } from "zod";
import { config } from "./config.js";
import { db } from "./database.js";
import { authenticate, requireCsrf } from "./security.js";

const maxAttachmentBytes = 20 * 1024 * 1024;
const maxExtractedCharacters = 80_000;
const safeAttachmentKey = /^[0-9a-f-]{36}\.(?:pdf|docx|txt|md|png|jpg)$/;

type AttachmentKind = {
  extension: "pdf" | "docx" | "txt" | "md" | "png" | "jpg";
  mime: string;
  extraction: "text" | "vision";
};

function hasPrefix(bytes: Uint8Array, expected: number[]) {
  return expected.every((value, index) => bytes[index] === value);
}

function detectAttachment(filename: string, bytes: Uint8Array) {
  const extension = extname(filename).toLowerCase();
  if (
    extension === ".pdf" &&
    new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-"
  )
    return {
      extension: "pdf",
      mime: "application/pdf",
      extraction: "text",
    } satisfies AttachmentKind;
  if (
    extension === ".docx" &&
    hasPrefix(bytes, [0x50, 0x4b, 0x03, 0x04]) &&
    Buffer.from(bytes).includes(Buffer.from("word/document.xml"))
  )
    return {
      extension: "docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      extraction: "text",
    } satisfies AttachmentKind;
  if (extension === ".png" && hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47]))
    return {
      extension: "png",
      mime: "image/png",
      extraction: "vision",
    } satisfies AttachmentKind;
  if (
    [".jpg", ".jpeg"].includes(extension) &&
    hasPrefix(bytes, [0xff, 0xd8, 0xff])
  )
    return {
      extension: "jpg",
      mime: "image/jpeg",
      extraction: "vision",
    } satisfies AttachmentKind;
  if ([".txt", ".md"].includes(extension)) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!text.includes("\0"))
        return {
          extension: extension.slice(1) as "txt" | "md",
          mime: extension === ".md" ? "text/markdown" : "text/plain",
          extraction: "text",
        } satisfies AttachmentKind;
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeExtractedText(value: string) {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, maxExtractedCharacters);
}

async function extractText(kind: AttachmentKind, bytes: Uint8Array) {
  if (kind.extraction === "vision") return undefined;
  if (kind.extension === "txt" || kind.extension === "md")
    return normalizeExtractedText(new TextDecoder().decode(bytes));
  if (kind.extension === "pdf")
    return normalizeExtractedText((await pdf(Buffer.from(bytes))).text);
  return normalizeExtractedText(
    (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value,
  );
}

function attachmentView(row: Record<string, any>) {
  return {
    id: row.id,
    name: row.metadata?.originalName ?? "附件",
    mimeType: row.mime_type,
    bytes: row.metadata?.bytes ?? 0,
    extractionStatus: row.metadata?.extractionStatus ?? "unknown",
    createdAt: row.created_at,
  };
}

export async function registerAttachmentRoutes(app: FastifyInstance) {
  await mkdir(config.ASSET_STORAGE_DIR, { recursive: true, mode: 0o750 });

  app.post(
    "/api/attachments/upload",
    { preHandler: [authenticate, requireCsrf] },
    async (request, reply) => {
      const file = await request.file();
      if (!file)
        return reply.code(400).send({ error: "ATTACHMENT_FILE_REQUIRED" });
      const bytes = new Uint8Array(await file.toBuffer());
      if (
        file.file.truncated ||
        !bytes.byteLength ||
        bytes.byteLength > maxAttachmentBytes
      )
        return reply.code(413).send({ error: "ATTACHMENT_TOO_LARGE" });
      const kind = detectAttachment(file.filename, bytes);
      if (!kind)
        return reply.code(400).send({ error: "INVALID_ATTACHMENT_FILE" });

      let extractedText: string | undefined;
      try {
        extractedText = await extractText(kind, bytes);
      } catch {
        return reply.code(422).send({ error: "ATTACHMENT_PARSE_FAILED" });
      }
      if (kind.extraction === "text" && !extractedText)
        return reply.code(422).send({ error: "ATTACHMENT_TEXT_EMPTY" });

      const id = randomUUID();
      const storageKey = `${id}.${kind.extension}`;
      await writeFile(join(config.ASSET_STORAGE_DIR, storageKey), bytes, {
        mode: 0o640,
        flag: "wx",
      });
      try {
        const result = await db.query(
          `INSERT INTO assets (id, created_by, source, kind, status, storage_key, mime_type, metadata)
           VALUES ($1, $2, 'upload', 'attachment', 'ready', $3, $4, $5::jsonb) RETURNING *`,
          [
            id,
            request.sessionUser!.id,
            storageKey,
            kind.mime,
            JSON.stringify({
              originalName: file.filename.slice(0, 160),
              bytes: bytes.byteLength,
              extractedText,
              extractionStatus:
                kind.extraction === "vision" ? "vision_required" : "ready",
            }),
          ],
        );
        return reply
          .code(201)
          .send({ attachment: attachmentView(result.rows[0]) });
      } catch (error) {
        await unlink(join(config.ASSET_STORAGE_DIR, storageKey)).catch(
          () => undefined,
        );
        throw error;
      }
    },
  );

  app.get(
    "/api/attachments/:attachmentId/file",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const parsed = z
        .object({ attachmentId: z.string().uuid() })
        .safeParse(request.params);
      if (!parsed.success)
        return reply.code(400).send({ error: "INVALID_ATTACHMENT_ID" });
      const result = await db.query(
        "SELECT * FROM assets WHERE id = $1 AND kind = 'attachment' AND status = 'ready'",
        [parsed.data.attachmentId],
      );
      const row = result.rows[0];
      if (
        !row ||
        (request.sessionUser!.role !== "admin" &&
          row.created_by !== request.sessionUser!.id) ||
        !safeAttachmentKey.test(row.storage_key ?? "")
      )
        return reply.code(404).send({ error: "NOT_FOUND" });
      reply
        .header("Content-Disposition", "attachment")
        .header("Cache-Control", "private, no-store")
        .type(row.mime_type ?? "application/octet-stream");
      return reply.send(
        createReadStream(join(config.ASSET_STORAGE_DIR, row.storage_key)),
      );
    },
  );

  app.delete(
    "/api/attachments/:attachmentId",
    { preHandler: [authenticate, requireCsrf] },
    async (request, reply) => {
      const parsed = z
        .object({ attachmentId: z.string().uuid() })
        .safeParse(request.params);
      if (!parsed.success)
        return reply.code(400).send({ error: "INVALID_ATTACHMENT_ID" });
      const result = await db.query(
        "SELECT * FROM assets WHERE id = $1 AND kind = 'attachment'",
        [parsed.data.attachmentId],
      );
      const row = result.rows[0];
      if (
        !row ||
        (request.sessionUser!.role !== "admin" &&
          row.created_by !== request.sessionUser!.id)
      )
        return reply.code(404).send({ error: "NOT_FOUND" });
      const inUse = await db.query(
        "SELECT 1 FROM content_jobs WHERE input->'attachmentIds' ? $1 LIMIT 1",
        [parsed.data.attachmentId],
      );
      if (inUse.rowCount)
        return reply.code(409).send({ error: "ATTACHMENT_IN_USE" });
      await db.query("DELETE FROM assets WHERE id = $1", [
        parsed.data.attachmentId,
      ]);
      if (safeAttachmentKey.test(row.storage_key ?? ""))
        await unlink(join(config.ASSET_STORAGE_DIR, row.storage_key)).catch(
          () => undefined,
        );
      return reply.code(204).send();
    },
  );
}
