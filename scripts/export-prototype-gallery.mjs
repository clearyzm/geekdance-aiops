import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const projectRoot = process.cwd();
const prototypePath = path.join(
  projectRoot,
  "design/aiops-platform-prototype.html",
);
const detailOutputDir = path.join(
  projectRoot,
  "design/exports/aiops-platform-complete/pages",
);
const galleryPath = path.join(projectRoot, "design/PROTOTYPE-GALLERY.md");
const chromeExecutable =
  process.env.CHROME_EXECUTABLE ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const coreFrames = [
  ["设计基础", "gD0Tf.png"],
  ["工作台总览", "oDq2S.png"],
  ["内容生产 · 通识文章", "E2HHGI.png"],
  ["内容生产 · 候选标题", "F4uEG.png"],
  ["任务详情 · 生成中", "kEOov.png"],
  ["人工复核 · 内容复核", "j8Nwb.png"],
  ["人工复核 · 渠道结果", "i3TtCf.png"],
  ["内容资产", "EggD3.png"],
  ["图片工坊", "dzSOP.png"],
  ["公众号默认结尾", "x9K1l.png"],
  ["渠道与扩展管理", "RXunK.png"],
  ["多账号发布 · 创建批次", "u1ekB.png"],
  ["多账号发布 · 部分成功", "cQIgN.png"],
  ["定时任务", "rFWoy.png"],
  ["成员管理", "G6HYhb.png"],
  ["系统设置", "KpTEh.png"],
  ["移动端人工复核", "p0x3vO.png"],
  ["扩展弹窗 · Ready", "cocTh.png"],
  ["扩展弹窗 · Action Required", "WDDkx.png"],
  ["全页面与状态覆盖地图", "VJIsC.png"],
];

const html = await readFile(prototypePath, "utf8");
const detailFrames = [
  ...html.matchAll(/\{id:"(PAGE-[^"]+)",title:"([^"]+)"/g),
].map((match) => ({ id: match[1], title: match[2] }));

if (detailFrames.length !== 28) {
  throw new Error(`Expected 28 detail frames, found ${detailFrames.length}`);
}

await mkdir(detailOutputDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: chromeExecutable,
  args: [
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--hide-scrollbars",
  ],
});

try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 1,
  });
  const prototypeUrl = pathToFileURL(prototypePath);

  for (const frame of detailFrames) {
    const frameUrl = new URL(prototypeUrl);
    frameUrl.searchParams.set("frame", frame.id);
    await page.goto(frameUrl.href, { waitUntil: "load" });
    await page.screenshot({
      path: path.join(detailOutputDir, `${frame.id}.png`),
      fullPage: false,
    });
  }
} finally {
  await browser.close();
}

const gallery = [
  "# 极客跳动 AI 运营中心｜完整原型图集",
  "",
  "> 本页直接展示 PNG 原型图，不需要运行代码。点击任意图片可在 GitHub 中查看原尺寸。",
  "",
  "## 核心流程与主要后台",
  "",
  ...coreFrames.flatMap(([title, file]) => [
    `### ${title}`,
    "",
    `![${title}](exports/aiops-platform/${file})`,
    "",
  ]),
  "## 补充业务页面与系统状态",
  "",
  ...detailFrames.flatMap(({ id, title }) => [
    `### ${title}`,
    "",
    `![${title}](exports/aiops-platform-complete/pages/${id}.png)`,
    "",
  ]),
  "## 可交互源文件",
  "",
  "需要逐页操作或使用 Frame ID 定位时，可下载并用浏览器打开 [\`aiops-platform-prototype.html\`](aiops-platform-prototype.html)。",
  "",
].join("\n");

await writeFile(galleryPath, gallery, "utf8");
console.log(
  `Exported ${detailFrames.length} detail PNGs and ${coreFrames.length} existing core PNGs into the gallery.`,
);
