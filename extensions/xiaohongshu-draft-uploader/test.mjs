import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

await import("./site-adapter.js");
const adapter = globalThis.GdXhsAdapter;
await import("./article-site-adapter.js");
const articleAdapter = globalThis.GdArticlePlatformAdapter;

assert.equal(adapter.allowedDraftAction.test("保存草稿"), true);
assert.equal(adapter.allowedDraftAction.test("暂存离开"), true);
assert.equal(adapter.allowedDraftAction.test("立即发布"), false);
assert.equal(adapter.forbiddenAction.test("立即发布"), true);
assert.equal(adapter.forbiddenAction.test("正式发布"), true);

const safeDraftButton = {
  innerText: "暂存离开",
  textContent: "暂存离开",
  getAttribute(name) {
    return name === "aria-label" ? "发布笔记" : null;
  },
};
assert.equal(adapter.isDraftAction(safeDraftButton), true);
assert.equal(adapter.isForbiddenAction(safeDraftButton), false);
assert.doesNotThrow(() => adapter.assertSafeAction(safeDraftButton));

const formalPublishButton = {
  innerText: "发布",
  textContent: "发布",
  getAttribute() {
    return "暂存离开";
  },
};
assert.equal(adapter.isDraftAction(formalPublishButton), false);
assert.equal(adapter.isForbiddenAction(formalPublishButton), true);
assert.throws(
  () => adapter.assertSafeAction(formalPublishButton),
  /FORMAL_PUBLISH_ACTION_FORBIDDEN/,
);
assert.equal(articleAdapter.allowedDraftAction.test("保存草稿"), true);
assert.equal(articleAdapter.allowedDraftAction.test("存入草稿箱"), true);
assert.equal(articleAdapter.allowedDraftAction.test("立即发布"), false);
assert.equal(articleAdapter.forbiddenAction.test("提交审核"), true);

const manifest = JSON.parse(
  await readFile(new URL("./manifest.json", import.meta.url)),
);
assert.equal(manifest.version, "1.4.0");
assert.ok(manifest.permissions.includes("scripting"));
assert.ok(manifest.permissions.includes("alarms"));
assert.deepEqual(manifest.host_permissions, [
  "https://aiops.geekdance.cn/*",
  "https://home.geekdance.app/*",
  "https://*.aliyuncs.com/*",
  "https://*.geekdance.cn/*",
  "http://127.0.0.1/*",
  "http://localhost/*",
  "https://creator.xiaohongshu.com/*",
  "https://www.zhihu.com/*",
  "https://zhuanlan.zhihu.com/*",
  "https://mp.toutiao.com/*",
  "https://baijiahao.baidu.com/*",
  "https://www.linkedin.com/*",
]);
assert.equal(manifest.host_permissions.includes("<all_urls>"), false);

const contentScript = await readFile(
  new URL("./content-script.js", import.meta.url),
  "utf8",
);
const articleSiteAdapter = await readFile(
  new URL("./article-site-adapter.js", import.meta.url),
  "utf8",
);
const background = await readFile(
  new URL("./background.js", import.meta.url),
  "utf8",
);
const apiServer = await readFile(
  new URL("../../apps/api/src/server.ts", import.meta.url),
  "utf8",
);
const popup = await readFile(new URL("./popup.js", import.meta.url), "utf8");
const popupHtml = await readFile(
  new URL("./popup.html", import.meta.url),
  "utf8",
);
const packageScript = await readFile(
  new URL("../../apps/web/scripts/package-xhs-extension.mjs", import.meta.url),
  "utf8",
);
const channelsPage = await readFile(
  new URL("../../apps/web/app/(portal)/channels/page.tsx", import.meta.url),
  "utf8",
);
const taskPage = await readFile(
  new URL(
    "../../apps/web/app/(portal)/tasks/[jobId]/page.tsx",
    import.meta.url,
  ),
  "utf8",
);
assert.doesNotMatch(contentScript, /adapter\.activate\(draftButton\)/);
assert.match(contentScript, /formalPublishForbidden/);
assert.match(contentScript, /formalPublishAuthorized/);
assert.match(contentScript, /FORMAL_PUBLISH_AUTHORIZATION_INVALID/);
assert.match(contentScript, /findPublishButton/);
assert.match(contentScript, /imageExtension/);
assert.match(contentScript, /findImageUploadTab/);
assert.match(contentScript, /XHS_IMAGE_TAB_MISSING/);
assert.match(contentScript, /adapter\.activate\(imageTab\)/);
assert.match(contentScript, /editorDiagnostics/);
assert.match(contentScript, /dropFiles/);
assert.match(contentScript, /adapter\.findDraftButton\(\)/);
assert.match(contentScript, /task\.deliveryKind === "multi_account"/);
assert.match(contentScript, /DRAFT_SAVE_SIGNAL_MISSING/);
assert.match(contentScript, /articleAdapter\.findDraftButton\(\)/);
assert.match(contentScript, /withLinkedInHashtags/);
assert.match(contentScript, /data-gd-linkedin-hashtags/);
assert.match(contentScript, /a\[href\*="\/in\/"\]/);
assert.match(articleSiteAdapter, /candidates\.length === 1/);
assert.match(articleSiteAdapter, /forbiddenAction/);
assert.match(articleSiteAdapter, /verificationSignal/);
assert.match(articleSiteAdapter, /zhuanlan\.zhihu\.com/);
assert.match(articleSiteAdapter, /mp\.toutiao\.com/);
assert.match(articleSiteAdapter, /baijiahao\.baidu\.com/);
assert.match(articleSiteAdapter, /www\.linkedin\.com/);
assert.match(articleSiteAdapter, /save as draft/i);
assert.match(articleSiteAdapter, /article published/i);
assert.doesNotMatch(contentScript, /observeSaveSignal/);
assert.match(
  background,
  /chrome\.tabs\.query\(\{ url: OPERATIONS_CENTER_URL_PATTERNS \}\)/,
);
assert.match(background, /files: \["website-bridge\.js"\]/);
assert.match(background, /chrome\.runtime\.onInstalled/);
assert.match(background, /chrome\.runtime\.onStartup/);
assert.match(background, /chrome\.tabs\.onUpdated/);
assert.doesNotMatch(background, /<all_urls>/);
assert.match(background, /图片下载超时/);
assert.match(background, /tasks\/\$\{task\.id\}\/heartbeat/);
assert.match(background, /ALLOWED_API_BASE_URLS/);
assert.match(background, /运营中心地址不在安全白名单中/);
assert.match(background, /image\/jpeg.*image\/png.*image\/webp/s);
assert.match(background, /tasks\/\$\{taskId\}\/images\/\$\{imageIndex\}/);
assert.doesNotMatch(background, /imageDataUrl\(image\.url\)/);
assert.match(background, /\.split\(";", 1\)/);
assert.match(background, /PAIR_EXTENSION/);
assert.match(background, /LOCAL_STATUS/);
assert.match(background, /GD_XHS_UPLOAD_PROGRESS/);
assert.match(background, /CONTENT_TASK_RESULT/);
assert.match(background, /waitForContentResult/);
assert.match(background, /ensureContentScript/);
assert.match(background, /chrome\.scripting\.executeScript/);
assert.match(background, /BROWSER_CONTENT_SCRIPT_NOT_READY/);
assert.match(
  background,
  /browser_delivery_items|deliveries\/claim|pollDeliveryTasks/,
);
assert.match(background, /DELIVERY_ACCOUNT_MISMATCH/);
assert.match(background, /必须从运营中心指定一个平台草稿任务/);
assert.match(background, /BROWSER_UPLOAD_TASK_NOT_CLAIMABLE/);
assert.match(contentScript, /execCommand\?\.\(\s*"insertText"/);
assert.match(contentScript, /insertParagraph/);
assert.match(contentScript, /addRealTopics/);
assert.match(contentScript, /CONTENT_TASK_RESULT/);
assert.match(contentScript, /GD_XHS_CONTENT_READY/);
assert.match(contentScript, /status: "filled"/);
assert.match(contentScript, /topicsSelected/);
assert.match(contentScript, /topicsFailed/);
assert.match(background, /chrome\.storage\.local\.remove\("token"\)/);
assert.match(background, /reconnectRequired/);
assert.match(apiServer, /\$3::text = 'admin' OR created_by = \$4/);
assert.match(
  apiServer,
  /WHERE status = 'waiting_for_uploader'[\s\S]*AND id = \$1 AND channel = \$2/,
);
assert.match(apiServer, /WHERE id = \$1 AND channel = \$2 FOR UPDATE/);
assert.match(apiServer, /:channel\/tasks\/:taskId\/images\/:imageIndex/);
assert.match(apiServer, /BROWSER_EXTENSION_NOT_CONNECTED/);
assert.doesNotMatch(apiServer, /XHS_EXTENSION_NOT_CONNECTED/);
assert.match(
  background,
  /START_NEXT_TASK[\s\S]*请从极客跳动 AI 运营中心的指定任务发起上传/,
);
assert.match(popup, /CHECK_CONNECTION/);
assert.match(popup, /首次上传并填写时会自动启用/);
assert.match(popup, /finally\s*{/);
assert.match(popupHtml, /多平台草稿助手/);
assert.doesNotMatch(popupHtml, /小红书草稿助手/);
assert.match(popup, /小红书、知乎、今日头条、百家号或 LinkedIn/);
assert.match(packageScript, /geekdance-multi-platform-draft-uploader\.zip/);
assert.match(packageScript, /geekdance-xiaohongshu-draft-uploader\.zip/);
assert.match(channelsPage, /REQUIRED_XHS_EXTENSION_VERSION = "1\.4\.0"/);
assert.match(taskPage, /REQUIRED_XHS_EXTENSION_VERSION = "1\.4\.0"/);
assert.match(channelsPage, /GD_XHS_CONNECTION_RESULT/);
assert.match(taskPage, /GD_XHS_CONNECTION_RESULT/);
assert.match(channelsPage, /当前标签页未检测到助手/);
assert.match(channelsPage, /扩展已安装，但暂时无法检查连接/);
assert.match(channelsPage, /browserChannelIds/);
assert.match(channelsPage, /当前电脑未安装/);
assert.match(channelsPage, /localExtension\.connected/);
assert.match(taskPage, /needsPairing/);

const bridge = await readFile(
  new URL("./website-bridge.js", import.meta.url),
  "utf8",
);
assert.match(bridge, /https:\/\/aiops\.geekdance\.cn/);
assert.match(bridge, /http:\/\/127\.0\.0\.1:3000/);
assert.match(bridge, /http:\/\/localhost:3000/);
assert.match(bridge, /START_TASK/);
assert.match(bridge, /GD_XHS_PAIR/);
assert.match(bridge, /GD_XHS_PAIR_RESULT/);
assert.match(bridge, /GD_XHS_UPLOAD_PROGRESS/);
assert.match(bridge, /LOCAL_STATUS/);
assert.match(bridge, /__GD_XHS_WEBSITE_BRIDGE_ACTIVE__/);
assert.match(bridge, /GD_XHS_CHECK_CONNECTION/);
assert.match(bridge, /GD_BIND_CHANNEL_ACCOUNT/);
assert.match(bridge, /GD_XHS_CONNECTION_RESULT/);
assert.match(bridge, /CHECK_CONNECTION/);
assert.doesNotMatch(bridge, /connectionPending/);
assert.doesNotMatch(bridge, /connected: result\?\.configured/);
assert.match(bridge, /chrome\.runtime\.getManifest\(\)\.version/);
assert.ok(manifest.host_permissions.includes("https://home.geekdance.app/*"));
assert.ok(manifest.host_permissions.includes("https://*.aliyuncs.com/*"));

const siteAdapter = await readFile(
  new URL("./site-adapter.js", import.meta.url),
  "utf8",
);
assert.match(siteAdapter, /保存成功/);
assert.match(siteAdapter, /aria-disabled/);
assert.match(siteAdapter, /aria-placeholder/);
assert.match(siteAdapter, /role="textbox"/);
assert.match(siteAdapter, /element\.disabled/);
assert.match(siteAdapter, /buttonText\(element\) === "上传图文"/);
assert.match(siteAdapter, /function actionTexts/);
assert.match(siteAdapter, /function findTopicButton/);
assert.match(siteAdapter, /function findTopicCandidate/);
assert.match(siteAdapter, /function hasExactTopicComponent/);
assert.match(siteAdapter, /function removeTopicQueryResidue/);
assert.match(
  contentScript,
  /adapter\.hasExactTopicComponent\(bodyInput, topic\)/,
);
assert.match(
  contentScript,
  /adapter\.removeTopicQueryResidue\(bodyInput, topic\)/,
);
assert.match(siteAdapter, /\.filter\(isDraftAction\)/);
assert.match(siteAdapter, /isForbiddenAction\(element\)/);
assert.doesNotMatch(siteAdapter, /input\[type="file"\]\[multiple\]/);
assert.doesNotMatch(contentScript, /setInterval/);
assert.doesNotMatch(contentScript, /MutationObserver/);

console.log("xiaohongshu extension safety checks passed");
