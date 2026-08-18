(() => {
  if (globalThis.GdArticlePlatformAdapter) return;

  const platformByHost = {
    "www.zhihu.com": "zhihu",
    "zhuanlan.zhihu.com": "zhihu",
    "mp.toutiao.com": "toutiao",
    "baijiahao.baidu.com": "baijiahao",
    "www.linkedin.com": "linkedin",
  };
  const verificationSignal =
    /验证码|安全验证|滑块验证|请完成验证|账号异常|登录后继续|扫码登录|security verification|verify your identity|sign in to continue/i;
  const savedSignal =
    /草稿已保存|保存草稿成功|已保存至草稿|保存成功|已自动保存|内容已保存|draft saved|saved to drafts/i;
  const publishedSignal =
    /发布成功|文章已发布|发布完成|已成功发布|提交成功|article published|post published|published successfully/i;
  const forbiddenAction =
    /发布|提交审核|确认发布|预览并发布|立即发布|^publish$|publish article|post now/i;
  const allowedDraftAction =
    /^(保存草稿|存草稿|暂存|暂存离开|保存并退出|存入草稿箱|save draft|save as draft|save and exit)$/i;

  function visible(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  function pageText() {
    return document.body?.innerText || "";
  }

  function platform() {
    return platformByHost[location.hostname] || null;
  }

  function uniqueVisible(selectors) {
    const candidates = [
      ...new Set(
        selectors.flatMap((selector) => [
          ...document.querySelectorAll(selector),
        ]),
      ),
    ].filter(visible);
    return candidates.length === 1 ? candidates[0] : null;
  }

  function findTitleInput() {
    const current = platform();
    const platformSelectors = {
      zhihu: [
        'textarea[placeholder*="标题"]',
        'input[placeholder*="标题"]',
        ".WriteIndex-titleInput textarea",
      ],
      toutiao: [
        'textarea[placeholder*="标题"]',
        'input[placeholder*="标题"]',
        '[data-testid*="title"] textarea',
      ],
      baijiahao: [
        'textarea[placeholder*="标题"]',
        'input[placeholder*="标题"]',
        ".title-input input",
      ],
      linkedin: [
        'textarea[placeholder*="Title"]',
        'input[placeholder*="Title"]',
        'textarea[aria-label*="Title"]',
        'input[aria-label*="Title"]',
        '[data-test-article-title] textarea',
        '[data-test-article-title] input',
      ],
    };
    return uniqueVisible([
      ...(platformSelectors[current] || []),
      '[contenteditable="true"][data-placeholder*="标题"]',
      '[role="textbox"][aria-label*="标题"]',
    ]);
  }

  function findBodyInput() {
    const current = platform();
    const platformSelectors = {
      zhihu: [
        '.DraftEditor-root [contenteditable="true"]',
        '.public-DraftEditor-content[contenteditable="true"]',
        '.ProseMirror[contenteditable="true"]',
      ],
      toutiao: [
        '.ProseMirror[contenteditable="true"]',
        '.ql-editor[contenteditable="true"]',
        '[data-testid*="editor"] [contenteditable="true"]',
      ],
      baijiahao: [
        '.ProseMirror[contenteditable="true"]',
        '.ql-editor[contenteditable="true"]',
        '[contenteditable="true"][data-placeholder*="正文"]',
      ],
      linkedin: [
        '.ProseMirror[contenteditable="true"]',
        '[data-test-article-content] [contenteditable="true"]',
        '[contenteditable="true"][data-placeholder*="Write"]',
        '[contenteditable="true"][aria-label*="article"]',
      ],
    };
    const title = findTitleInput();
    const explicit = uniqueVisible([
      ...(platformSelectors[current] || []),
      '[contenteditable="true"][data-placeholder*="正文"]',
      '[contenteditable="true"][placeholder*="正文"]',
      '[role="textbox"][aria-label*="正文"]',
    ]);
    return explicit && explicit !== title ? explicit : null;
  }

  function actionText(element) {
    return (
      element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      element.innerText ||
      element.textContent ||
      ""
    )
      .replace(/\s+/g, "")
      .trim();
  }

  function findDraftButton() {
    const candidates = [...document.querySelectorAll('button,[role="button"]')]
      .filter(visible)
      .filter((element) => {
        const text = actionText(element);
        return allowedDraftAction.test(text) && !forbiddenAction.test(text);
      });
    return candidates.length === 1 ? candidates[0] : null;
  }

  function findPublishButton() {
    const candidates = [...document.querySelectorAll('button,[role="button"]')]
      .filter(visible)
      .filter((element) => forbiddenAction.test(actionText(element)));
    return candidates.length === 1 ? candidates[0] : null;
  }

  function activate(element) {
    element.scrollIntoView({ block: "center", inline: "center" });
    element.focus();
    element.click();
  }

  globalThis.GdArticlePlatformAdapter = {
    platform,
    pageText,
    findTitleInput,
    findBodyInput,
    findDraftButton,
    findPublishButton,
    activate,
    verificationSignal,
    savedSignal,
    publishedSignal,
    forbiddenAction,
    allowedDraftAction,
  };
})();
