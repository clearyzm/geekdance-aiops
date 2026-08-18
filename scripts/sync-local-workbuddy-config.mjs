import { chmod, readFile, writeFile } from "node:fs/promises";

const projectEnv = new URL("../.env", import.meta.url);
const workBuddyConfig = "/Users/yangzimo/.workbuddy/mcp.json";
const config = JSON.parse(await readFile(workBuddyConfig, "utf8"));
const source = config.mcpServers?.["geekdance-official-site"]?.env;
const wechatSource = config.mcpServers?.["wechat-publisher"]?.env;
if (!source) throw new Error("没有找到本地 geekdance-official-site 配置");

const values = {
  OFFICIAL_BASE_URL: source.OFFICIAL_BASE_URL_PROD || source.OFFICIAL_BASE_URL,
  OFFICIAL_ADMIN_TOKEN: source.OFFICIAL_ADMIN_TOKEN || "",
  OFFICIAL_ADMIN_USERNAME: source.OFFICIAL_ADMIN_USERNAME || "",
  OFFICIAL_ADMIN_PASSWORD: source.OFFICIAL_ADMIN_PASSWORD || "",
  GEEKHOME_MATERIAL_MCP_URL: source.GEEKHOME_MATERIAL_MCP_URL || "",
  GEEKHOME_MATERIAL_TOKEN: source.GEEKHOME_MATERIAL_TOKEN || "",
  WECHAT_PUBLISHER_MODE: "mock",
  WECHAT_ALLOW_PROD: "false",
  WECHAT_APP_ID: wechatSource?.WECHAT_APP_ID || "",
  WECHAT_APP_SECRET: wechatSource?.WECHAT_APP_SECRET || "",
};
const configured = Object.entries(values)
  .filter(([, value]) => value)
  .map(([key]) => key);
if (
  !values.OFFICIAL_BASE_URL ||
  (!values.OFFICIAL_ADMIN_TOKEN &&
    !(values.OFFICIAL_ADMIN_USERNAME && values.OFFICIAL_ADMIN_PASSWORD))
)
  throw new Error("现有 WorkBuddy 官网凭据不完整");

let text = await readFile(projectEnv, "utf8");
for (const [key, value] of Object.entries(values)) {
  const line = `${key}=${String(value).replace(/[\r\n]/g, "")}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  text = pattern.test(text)
    ? text.replace(pattern, line)
    : `${text.trimEnd()}\n${line}\n`;
}
await writeFile(projectEnv, text, { mode: 0o600 });
await chmod(projectEnv, 0o600);
console.log(JSON.stringify({ imported: configured, destinationMode: "0600" }));
