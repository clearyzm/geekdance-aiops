import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { verify } from "@node-rs/argon2";
import type { SessionUser } from "@geekdance/shared";
import { config } from "./config.js";
import { db } from "./database.js";

const SESSION_COOKIE = "gd_ops_session";
const CSRF_COOKIE = "gd_ops_csrf";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function hashExtensionToken(token: string) {
  return sha256(`${config.SESSION_SECRET}:extension:${token}`);
}

export function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function verifyPassword(passwordHash: string, password: string) {
  return verify(passwordHash, password);
}

export async function createSession(userId: string, reply: FastifyReply) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.query(
    "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)",
    [
      randomUUID(),
      userId,
      sha256(`${config.SESSION_SECRET}:${token}`),
      expiresAt,
    ],
  );
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const token = request.cookies[SESSION_COOKIE];
  if (token)
    await db.query("DELETE FROM sessions WHERE token_hash = $1", [
      sha256(`${config.SESSION_SECRET}:${token}`),
    ]);
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function issueCsrf(reply: FastifyReply) {
  const token = randomBytes(24).toString("base64url");
  reply.setCookie(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: config.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 60 * 60,
  });
  return token;
}

export async function requireCsrf(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const cookie = request.cookies[CSRF_COOKIE];
  const header = request.headers["x-csrf-token"];
  if (!cookie || typeof header !== "string" || !safeEqual(cookie, header)) {
    return reply.code(403).send({
      error: "CSRF_INVALID",
      message: "安全令牌已失效，请刷新页面后重试",
    });
  }
}

declare module "fastify" {
  interface FastifyRequest {
    sessionUser?: SessionUser;
    extensionAuth?: {
      tokenId: string;
      user: SessionUser;
    };
  }
}

export async function authenticateExtension(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const authorization = request.headers.authorization;
  const match = authorization?.match(/^Bearer\s+(gdxhs_[A-Za-z0-9_-]{32,})$/);
  if (!match) return reply.code(401).send({ error: "EXTENSION_UNAUTHORIZED" });
  const result = await db.query(
    `SELECT et.id AS token_id, u.id, u.email, u.display_name, u.role, u.must_change_password
     FROM extension_tokens et JOIN users u ON u.id = et.user_id
     WHERE et.token_hash = $1 AND et.revoked_at IS NULL AND et.expires_at > NOW()
       AND u.status = 'active'`,
    [hashExtensionToken(match[1]!)],
  );
  const row = result.rows[0];
  if (!row) return reply.code(401).send({ error: "EXTENSION_UNAUTHORIZED" });
  const user: SessionUser = {
    id: row.id,
    email: row.email,
    name: row.display_name,
    role: row.role,
    mustChangePassword: row.must_change_password,
  };
  request.extensionAuth = { tokenId: row.token_id, user };
  await db.query(
    "UPDATE extension_tokens SET last_used_at = NOW() WHERE id = $1",
    [row.token_id],
  );
}

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return reply.code(401).send({ error: "UNAUTHORIZED" });
  const result = await db.query(
    `SELECT u.id, u.email, u.display_name, u.role, u.must_change_password
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.status = 'active'`,
    [sha256(`${config.SESSION_SECRET}:${token}`)],
  );
  const row = result.rows[0];
  if (!row) return reply.code(401).send({ error: "UNAUTHORIZED" });
  request.sessionUser = {
    id: row.id,
    email: row.email,
    name: row.display_name,
    role: row.role,
    mustChangePassword: row.must_change_password,
  };
  if (
    row.must_change_password &&
    !new Set([
      "/api/auth/me",
      "/api/auth/change-password",
      "/api/auth/logout",
    ]).has(request.url.split("?", 1)[0] ?? "")
  )
    return reply.code(428).send({
      error: "PASSWORD_CHANGE_REQUIRED",
      message: "首次登录必须先修改临时密码",
    });
}

export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  await authenticate(request, reply);
  if (reply.sent) return;
  if (request.sessionUser?.role !== "admin")
    return reply.code(403).send({ error: "FORBIDDEN" });
}
