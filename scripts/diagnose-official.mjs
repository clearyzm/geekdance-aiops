import { readFile } from "node:fs/promises";
import { OfficialSitePublisher } from "../packages/channel-adapters/dist/index.js";

const text = await readFile(new URL("../.env", import.meta.url), "utf8");
const env = Object.fromEntries(
  text
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)];
    }),
);
const publisher = new OfficialSitePublisher({
  mode: "live",
  baseUrl: env.OFFICIAL_BASE_URL,
  allowProduction: false,
  bearerToken: env.OFFICIAL_ADMIN_TOKEN,
  username: env.OFFICIAL_ADMIN_USERNAME,
  password: env.OFFICIAL_ADMIN_PASSWORD,
  uploadDir: env.OFFICIAL_UPLOAD_DIR,
  allowedImageHosts: (env.OFFICIAL_IMAGE_ALLOWED_HOSTS || "")
    .split(",")
    .filter(Boolean),
});
console.log(JSON.stringify(await publisher.diagnose(), null, 2));
