import { z } from "zod";

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  APP_RELEASE: z.string().min(1).max(128).default("local"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(4).default(0),
  APP_ORIGIN: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email(),
  BOOTSTRAP_ADMIN_NAME: z.string().min(1).default("系统管理员"),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12),
  CONTENT_QUEUE_NAME: z.string().min(1).default("content-jobs"),
  AUTOMATION_QUEUE_NAME: z.string().min(1).default("automation-jobs"),
  IMAGE_QUEUE_NAME: z.string().min(1).default("image-jobs"),
  ASSET_STORAGE_DIR: z.string().min(1).default("/data/assets"),
  ASSET_PUBLIC_SECRET: z.string().min(32).optional(),
  ASSET_ACCEL_REDIRECT: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
  OSS_ENDPOINT: z.string().url().optional(),
  OSS_BUCKET: z.string().optional(),
  OSS_PREFIX: z.string().default("ai-ops"),
  OSS_ACCESS_KEY_ID: z.string().optional(),
  OSS_ACCESS_KEY_SECRET: z.string().optional(),
  CONTENT_ENGINE_MODE: z
    .enum(["mock", "mock_geekhome", "openrouter", "openai"])
    .default("mock"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_TEXT_MODEL: z.string().default("gpt-5.6-sol"),
  OPENAI_REASONING_EFFORT: z
    .enum(["none", "low", "medium", "high", "xhigh", "max"])
    .default("medium"),
  IMAGE_PROVIDER_MODE: z.enum(["mock", "openrouter", "openai"]).default("mock"),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_TEXT_API_KEY: z.string().optional(),
  OPENROUTER_IMAGE_API_KEY: z.string().optional(),
  OPENROUTER_TEXT_MODEL: z.string().default("qwen/qwen3.7-plus"),
  OPENROUTER_TEXT_BASE_URL: z
    .string()
    .url()
    .default("https://openrouter.ai/api/v1"),
  GEEKHOME_MATERIAL_MCP_URL: z.string().url().optional(),
  GEEKHOME_MATERIAL_TOKEN: z.string().optional(),
  XIAOHONGSHU_IMAGE_ALLOWED_HOSTS: z
    .string()
    .default("home.geekdance.app,.aliyuncs.com,.geekdance.cn"),
  OPENROUTER_IMAGE_MODEL: z.string().default("openai/gpt-5.4-image-2"),
  OPENAI_IMAGE_API_KEY: z.string().optional(),
  OPENAI_IMAGE_MODEL: z.string().default("gpt-image-2"),
  OFFICIAL_PUBLISHER_MODE: z.enum(["off", "mock", "live"]).default("off"),
  OFFICIAL_BASE_URL: z.string().url().default("https://www.geekdance.cn"),
  OFFICIAL_ALLOW_PROD: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
  OFFICIAL_ADMIN_TOKEN: z.string().optional(),
  OFFICIAL_ADMIN_USERNAME: z.string().optional(),
  OFFICIAL_ADMIN_PASSWORD: z.string().optional(),
  WECHAT_PUBLISHER_MODE: z.enum(["off", "mock", "live"]).default("off"),
});

export const config = schema.parse(process.env);
