import { readFile } from "node:fs/promises";
import { WechatOfficialPublisher } from "../packages/channel-adapters/dist/index.js";

const text = await readFile(new URL("../.env", import.meta.url), "utf8");
const values = Object.fromEntries(
  text
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)];
    }),
);

const publisher = new WechatOfficialPublisher({
  mode: "live",
  allowProduction: false,
  appId: values.WECHAT_APP_ID,
  appSecret: values.WECHAT_APP_SECRET,
  apiBaseUrl: values.WECHAT_API_BASE_URL || "https://api.weixin.qq.com",
  author: values.WECHAT_AUTHOR || "极客跳动",
  contentSourceUrl:
    values.WECHAT_CONTENT_SOURCE_URL || "https://www.geekdance.cn",
  allowedImageHosts: (
    values.WECHAT_IMAGE_ALLOWED_HOSTS ||
    "home.geekdance.app,.aliyuncs.com,.geekdance.cn"
  )
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
  promoBoardPath:
    values.WECHAT_PROMO_BOARD_PATH ||
    "apps/web/public/brand/geekdance-promo-board.png",
});
const result = await publisher.diagnose();
console.log(JSON.stringify(result));
if (!result.ok) process.exitCode = 1;
