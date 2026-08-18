import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const envText = await readFile(
  process.env.SMOKE_ENV_FILE ?? new URL("../.env", import.meta.url),
  "utf8",
);
const env = {
  ...Object.fromEntries(
    envText
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  ),
  ...process.env,
};
const baseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:4000";
const cookies = new Map();

function capture(response) {
  const values =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
  for (const value of values) {
    const pair = value.split(";", 1)[0];
    const index = pair.indexOf("=");
    if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1));
  }
}
function cookie() {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}
async function raw(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...(cookies.size ? { cookie: cookie() } : {}),
    },
  });
  capture(response);
  return response;
}
async function json(path, init = {}) {
  const response = await raw(path, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      `${init.method ?? "GET"} ${path} -> ${response.status} ${data.error ?? data.message ?? "UNKNOWN"}`,
    );
  return data;
}
async function csrf() {
  return (await json("/api/auth/csrf")).csrfToken;
}
async function mutate(path, body) {
  return json(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": await csrf(),
    },
    body: JSON.stringify(body),
  });
}
async function wait(jobId, timeout = 240_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const response = await raw(`/api/image-jobs/${jobId}`);
    if (response.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      continue;
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(`image job polling failed: ${response.status}`);
    if (result.terminal) return result.job;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`image job timeout: ${jobId}`);
}
async function submit(input) {
  return wait(
    (
      await mutate("/api/image-jobs", {
        operationId: randomUUID(),
        quality: "standard",
        count: 1,
        layout: "grid",
        logoPosition: "bottom_right",
        rightsConfirmed: false,
        ...input,
      })
    ).job.id,
  );
}
function imageSize(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] === 0x89 && String.fromCharCode(...bytes.slice(1, 4)) === "PNG")
    return [view.getUint32(16), view.getUint32(20)];
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      const length = view.getUint16(offset + 2);
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker)
      )
        return [view.getUint16(offset + 7), view.getUint16(offset + 5)];
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  throw new Error("output is not a supported PNG or JPEG image");
}
async function assetSize(asset) {
  const response = await raw(asset.fileUrl);
  if (!response.ok)
    throw new Error(`asset download failed: ${response.status}`);
  return imageSize(new Uint8Array(await response.arrayBuffer()));
}

const adminLogin = await json("/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json", "x-csrf-token": await csrf() },
  body: JSON.stringify({
    email: env.BOOTSTRAP_ADMIN_EMAIL,
    password:
      env.SMOKE_ADMIN_PERMANENT_PASSWORD ?? env.BOOTSTRAP_ADMIN_PASSWORD,
  }),
});
if (adminLogin.user.mustChangePassword)
  await mutate("/api/auth/change-password", {
    currentPassword:
      env.SMOKE_ADMIN_PERMANENT_PASSWORD ?? env.BOOTSTRAP_ADMIN_PASSWORD,
    newPassword:
      env.SMOKE_ADMIN_PERMANENT_PASSWORD ?? `Stage6!Admin-${randomUUID()}`,
  });

const uploadForm = new FormData();
uploadForm.append(
  "file",
  new Blob(
    [
      await readFile(
        new URL("../apps/web/public/brand/geekdance-logo.png", import.meta.url),
      ),
    ],
    { type: "image/png" },
  ),
  "geekdance-logo.png",
);
const uploadResponse = await raw("/api/assets/upload", {
  method: "POST",
  headers: { "x-csrf-token": await csrf() },
  body: uploadForm,
});
const uploaded = await uploadResponse.json();
if (!uploadResponse.ok || !uploaded.asset?.id)
  throw new Error("authenticated image upload failed");

const generated = await submit({
  operation: "generate",
  prompt: "企业团队与 AI 智能体协作，主体靠右，左侧留白",
  ratio: "16:9",
  count: 2,
  sourceAssetIds: [],
});
if (
  generated.status !== "completed" ||
  generated.outputs.length !== 2 ||
  String(await assetSize(generated.outputs[0])) !== "1600,900"
)
  throw new Error("mock generation failed");

const resized = await submit({
  operation: "resize",
  ratio: "1:1",
  sourceAssetIds: [generated.outputs[0].id],
});
if (
  resized.status !== "completed" ||
  String(await assetSize(resized.outputs[0])) !== "1200,1200"
)
  throw new Error("resize failed");

const logo = await submit({
  operation: "logo_overlay",
  ratio: "16:9",
  logoPlacement: { x: 0.74, y: 0.82, width: 0.22 },
  sourceAssetIds: [generated.outputs[0].id, uploaded.asset.id],
});
if (
  logo.status !== "completed" ||
  String(await assetSize(logo.outputs[0])) !== "1600,900"
)
  throw new Error("logo overlay failed");

const guarded = await submit({
  operation: "compose",
  prompt: "自动匹配人物与背景的透视和光线",
  ratio: "16:9",
  sourceAssetIds: [uploaded.asset.id, generated.outputs[0].id],
  rightsConfirmed: false,
});
if (
  guarded.status !== "manual_review" ||
  guarded.errorCode !== "SOURCE_RIGHTS_CONFIRMATION_REQUIRED"
)
  throw new Error("creative rights gate failed");

const creative = await submit({
  operation: "compose",
  prompt: "自动匹配前景与背景的透视和光线",
  ratio: "16:9",
  sourceAssetIds: [uploaded.asset.id, generated.outputs[0].id],
  rightsConfirmed: true,
});
const creativeSize =
  creative.outputs?.[0] && (await assetSize(creative.outputs[0]));
if (creative.status !== "completed" || String(creativeSize) !== "1600,900")
  throw new Error(
    `authorized compose failed: ${creative.status} ${creative.errorCode ?? "UNKNOWN"} ${String(creativeSize)}`,
  );

const verified = [
  "authenticated_upload",
  "raster_mock_generation",
  "ratio_resize",
  "approved_logo_overlay",
  "compose_rights_gate",
  "authorized_auto_compose",
];
if (process.env.STAGE6_TEST_REMBG === "true") {
  const removed = await submit({
    operation: "remove_background",
    ratio: "16:9",
    sourceAssetIds: [generated.outputs[0].id],
  });
  if (
    removed.status !== "completed" ||
    String(await assetSize(removed.outputs[0])) !== "1600,900"
  )
    throw new Error(
      `background removal failed: ${removed.errorCode ?? removed.status}`,
    );
  verified.push("rembg_transparent_png");
}

console.log(
  JSON.stringify({
    ok: true,
    verified,
    generatedAssetIds: generated.outputs.map((asset) => asset.id),
  }),
);
