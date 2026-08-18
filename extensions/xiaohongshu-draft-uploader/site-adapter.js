(() => {
  const forbiddenAction = /^(?:发布|立即发布|确认发布|正式发布|发布笔记)$/;
  const allowedDraftAction = /^(保存草稿|存草稿|暂存离开)(?!.*发布)/;
  const savedSignal =
    /草稿已保存|保存草稿成功|已保存至草稿|已自动保存|保存成功/;
  const publishedSignal = /发布成功|笔记已发布|发布完成|已成功发布/;
  const verificationSignal = /验证码|安全验证|滑块验证|请完成验证|账号异常/;

  function visible(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    const view = element.ownerDocument?.defaultView || window;
    const style = view.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  function uniqueVisible(selectors, label) {
    const matches = selectors
      .flatMap((selector) => [...document.querySelectorAll(selector)])
      .filter(visible)
      .filter((item, index, values) => values.indexOf(item) === index);
    if (matches.length !== 1)
      throw new Error(
        `${label}_SELECTOR_${matches.length === 0 ? "MISSING" : "AMBIGUOUS"}`,
      );
    return matches[0];
  }

  function unique(selectors, label) {
    const matches = selectors
      .flatMap((selector) => [...document.querySelectorAll(selector)])
      .filter((item, index, values) => values.indexOf(item) === index);
    if (matches.length !== 1)
      throw new Error(
        `${label}_SELECTOR_${matches.length === 0 ? "MISSING" : "AMBIGUOUS"}`,
      );
    return matches[0];
  }

  function findFileInput() {
    return unique(
      [
        'input[type="file"][accept*="image"]',
        'input[type="file"][accept*=".jpg"]',
        'input[type="file"][accept*=".jpeg"]',
        'input[type="file"][accept*=".png"]',
        'input[type="file"][accept*=".webp"]',
      ],
      "IMAGE_INPUT",
    );
  }

  function findImageDropZone() {
    const labels = queryAllDeep("button, [role='button'], span, div")
      .filter(visible)
      .filter((element) =>
        /^(上传图片|上传图片，或写文字生成图片)$/.test(buttonText(element)),
      )
      .sort((left, right) => {
        const a = left.getBoundingClientRect();
        const b = right.getBoundingClientRect();
        return a.width * a.height - b.width * b.height;
      });
    const label = labels[0];
    if (!label) return null;
    return (
      label.closest(
        'label, button, [role="button"], [class*="upload"], [class*="drop"]',
      ) || label.parentElement
    );
  }

  function dropFiles(element, transfer) {
    if (!element) return false;
    const view = element.ownerDocument?.defaultView || window;
    for (const type of ["dragenter", "dragover", "drop"])
      element.dispatchEvent(
        new view.DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }),
      );
    return true;
  }

  function findImageUploadTab() {
    const candidates = [
      ...document.querySelectorAll(
        '[role="tab"], button, [role="button"], span, div',
      ),
    ]
      .filter(visible)
      .filter((element) => buttonText(element) === "上传图文")
      .filter((element) => element.getBoundingClientRect().top < 320)
      .sort((left, right) => {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        return (
          leftRect.width * leftRect.height - rightRect.width * rightRect.height
        );
      });
    const candidate = candidates[0];
    if (!candidate) return null;
    return (
      candidate.closest(
        'button, [role="tab"], [role="button"], [tabindex], [class*="tab"]',
      ) || candidate
    );
  }

  function activate(element) {
    const view = element.ownerDocument?.defaultView || window;
    element.scrollIntoView({ block: "center", inline: "center" });
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"])
      element.dispatchEvent(
        new view.MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view,
          button: 0,
        }),
      );
    element.click();
  }

  function editorDiagnostics(fileInput) {
    const editables = editableCandidates();
    return {
      fileAccept: fileInput?.getAttribute("accept") || "",
      fileMultiple: Boolean(fileInput?.multiple),
      selectedFiles: Number(fileInput?.files?.length || 0),
      editableCount: editables.length,
      editableHints: editables
        .slice(0, 8)
        .map((element) => editableHint(element).slice(0, 80)),
      pageSignals: [
        "上传视频",
        "上传图文",
        "上传图片",
        "标题",
        "正文",
        "保存草稿",
      ].filter((signal) => pageText().includes(signal)),
    };
  }

  function findTitleInput() {
    const explicit = editableMatches([
      'input[placeholder*="标题"]',
      'textarea[placeholder*="标题"]',
      '[contenteditable="true"][data-placeholder*="标题"]',
      '[contenteditable="true"][placeholder*="标题"]',
      '[role="textbox"][aria-label*="标题"]',
      '[role="textbox"][data-placeholder*="标题"]',
      '[role="textbox"][placeholder*="标题"]',
      '[contenteditable="plaintext-only"][data-placeholder*="标题"]',
    ]);
    if (explicit.length > 0) return bestTitleCandidate(explicit);

    const candidates = editableCandidates().filter((element) => {
      const hint = editableHint(element);
      return /标题|更多赞/.test(hint);
    });
    if (candidates.length === 0)
      throw new Error("TITLE_INPUT_SELECTOR_MISSING");
    return bestTitleCandidate(candidates);
  }

  function findBodyInput() {
    const explicit = editableMatches([
      'textarea[placeholder*="正文"]',
      'textarea[placeholder*="描述"]',
      '[contenteditable="true"][data-placeholder*="正文"]',
      '[contenteditable="true"][data-placeholder*="描述"]',
      '[contenteditable="true"][placeholder*="正文"]',
      '[contenteditable="true"][placeholder*="描述"]',
      '[role="textbox"][aria-label*="正文"]',
      '[role="textbox"][aria-label*="描述"]',
      '[role="textbox"][data-placeholder*="正文"]',
      '[role="textbox"][data-placeholder*="描述"]',
      '[role="textbox"][placeholder*="正文"]',
      '[role="textbox"][placeholder*="描述"]',
      '[contenteditable="plaintext-only"][data-placeholder*="正文"]',
      '[contenteditable="plaintext-only"][data-placeholder*="描述"]',
      ".ProseMirror[contenteditable]",
      ".ql-editor[contenteditable]",
    ]);
    if (explicit.length > 0) return bestBodyCandidate(explicit);

    const title = (() => {
      try {
        return findTitleInput();
      } catch {
        return null;
      }
    })();
    const candidates = editableCandidates()
      .filter((element) => element !== title)
      .filter((element) => /正文|描述|分享|温暖/.test(editableHint(element)));
    if (candidates.length === 0) throw new Error("BODY_INPUT_SELECTOR_MISSING");
    return bestBodyCandidate(candidates);
  }

  function ownEditableHint(element) {
    return [
      element.getAttribute("placeholder"),
      element.getAttribute("data-placeholder"),
      element.getAttribute("aria-label"),
      element.getAttribute("aria-placeholder"),
    ]
      .filter(Boolean)
      .join(" ");
  }

  function bestTitleCandidate(candidates) {
    return [...candidates].sort((left, right) => {
      const score = (element) => {
        const view = element.ownerDocument?.defaultView || window;
        const rect = element.getBoundingClientRect();
        return (
          (/标题|更多赞/.test(ownEditableHint(element)) ? 1000 : 0) +
          (element instanceof view.HTMLInputElement ? 200 : 0) +
          (rect.height <= 80 ? 50 : 0) -
          rect.top / 10_000
        );
      };
      return score(right) - score(left);
    })[0];
  }

  function bestBodyCandidate(candidates) {
    return [...candidates].sort((left, right) => {
      const score = (element) => {
        const view = element.ownerDocument?.defaultView || window;
        const rect = element.getBoundingClientRect();
        return (
          (/正文|描述|分享|温暖/.test(ownEditableHint(element)) ? 1000 : 0) +
          (element instanceof view.HTMLTextAreaElement ? 200 : 0) +
          (element.isContentEditable ? 150 : 0) +
          Math.min(rect.width * rect.height, 200_000) / 10_000
        );
      };
      return score(right) - score(left);
    })[0];
  }

  function editableMatches(selectors) {
    return selectors
      .flatMap((selector) => queryAllDeep(selector))
      .map(resolveEditable)
      .filter(Boolean)
      .filter(visible)
      .filter((item, index, values) => values.indexOf(item) === index);
  }

  function editableCandidates() {
    return queryAllDeep(
      'input, textarea, [contenteditable="true"], [role="textbox"]',
    )
      .map(resolveEditable)
      .filter(Boolean)
      .filter(visible)
      .filter((item, index, values) => values.indexOf(item) === index);
  }

  function resolveEditable(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;
    const view = element.ownerDocument?.defaultView || window;
    if (
      element instanceof view.HTMLInputElement ||
      element instanceof view.HTMLTextAreaElement ||
      element.isContentEditable ||
      element.getAttribute("role") === "textbox"
    )
      return element;
    return element.closest(
      'input, textarea, [contenteditable="true"], [role="textbox"]',
    );
  }

  function queryAllDeep(selector) {
    const roots = collectRoots();
    const matches = [];
    for (const root of roots) {
      try {
        matches.push(...root.querySelectorAll(selector));
      } catch {
        // A root can disappear during editor hydration; the next retry sees it.
      }
    }
    return matches.filter(
      (item, itemIndex, values) => values.indexOf(item) === itemIndex,
    );
  }

  function collectRoots() {
    const roots = [document];
    for (let index = 0; index < roots.length; index += 1) {
      const root = roots[index];
      try {
        for (const element of root.querySelectorAll("*")) {
          if (element.shadowRoot && !roots.includes(element.shadowRoot))
            roots.push(element.shadowRoot);
          if (element.tagName === "IFRAME") {
            try {
              if (
                element.contentDocument &&
                !roots.includes(element.contentDocument)
              )
                roots.push(element.contentDocument);
            } catch {
              // Cross-origin frames are intentionally ignored.
            }
          }
        }
      } catch {
        // Ignore roots removed while the editor is hydrating.
      }
    }
    return roots;
  }

  function editableHint(element) {
    return [
      element.getAttribute("placeholder"),
      element.getAttribute("data-placeholder"),
      element.getAttribute("aria-label"),
      element.getAttribute("aria-placeholder"),
      element.textContent,
    ]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function buttonText(element) {
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

  function actionTexts(element) {
    return [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.innerText,
      element.textContent,
    ]
      .filter(Boolean)
      .map((value) => value.replace(/\s+/g, "").trim())
      .filter(Boolean);
  }

  function visibleActionText(element) {
    return (element.innerText || element.textContent || "")
      .replace(/\s+/g, "")
      .trim();
  }

  function isDraftAction(element) {
    const visibleText = visibleActionText(element);
    if (visibleText) return allowedDraftAction.test(visibleText);
    return actionTexts(element).some((text) => allowedDraftAction.test(text));
  }

  function isForbiddenAction(element) {
    const visibleText = visibleActionText(element);
    if (visibleText) return forbiddenAction.test(visibleText);
    return actionTexts(element).some((text) => forbiddenAction.test(text));
  }

  function findDraftButton() {
    const buttons = queryAllDeep("*")
      .filter(visible)
      // Xiaohongshu currently gives “暂存离开” a non-matching aria-label.
      // Check every accessible/text source independently instead of letting
      // aria-label hide the visible button copy.
      .filter(isDraftAction)
      .map((element) => element.closest("button, [role='button']") || element)
      .filter((item, index, values) => values.indexOf(item) === index)
      .filter((element) => {
        const view = element.ownerDocument?.defaultView || window;
        return (
          !(element instanceof view.HTMLButtonElement && element.disabled) &&
          element.getAttribute("aria-disabled") !== "true"
        );
      })
      .sort((left, right) => {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        return (
          leftRect.width * leftRect.height - rightRect.width * rightRect.height
        );
      });
    return buttons.length === 1 ? buttons[0] : null;
  }

  function findTopicButton() {
    const buttons = queryAllDeep("button, [role='button']")
      .filter(visible)
      .filter((element) => buttonText(element) === "话题")
      .filter((element) => {
        const view = element.ownerDocument?.defaultView || window;
        return (
          !(element instanceof view.HTMLButtonElement && element.disabled) &&
          element.getAttribute("aria-disabled") !== "true"
        );
      });
    return buttons[0] || null;
  }

  function findTopicCandidate(topic) {
    const expected = `#${topic}`;
    const candidates = queryAllDeep(
      "[role='option'], li, button, [role='button'], span, div",
    )
      .filter(visible)
      .filter((element) => {
        const text = buttonText(element);
        return text === expected || text === `${expected}新建话题`;
      })
      // Never treat text that already exists in the editor or preview as an
      // autocomplete result. The creator page repeats the current note in
      // several nested divs, and clicking one of those containers can leave
      // the autocomplete's unrelated first recommendation selected.
      .filter(
        (element) =>
          !element.matches("[contenteditable='true']") &&
          !element.closest("[contenteditable='true'], textarea, input"),
      )
      .sort((left, right) => {
        const a = left.getBoundingClientRect();
        const b = right.getBoundingClientRect();
        return a.width * a.height - b.width * b.height;
      });
    const candidate = candidates[0];
    if (!candidate) return null;
    return (
      candidate.closest(
        "[role='option'], li, button, [role='button'], [class*='item']",
      ) || candidate
    );
  }

  function hasExactTopicComponent(element, topic) {
    const value =
      "value" in element && typeof element.value === "string"
        ? element.value
        : element.innerText || element.textContent || "";
    const escaped = topic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`#${escaped}\\s*\\[话题\\]#`, "u").test(value);
  }

  function removeTopicQueryResidue(element, topic) {
    const escaped = topic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const componentPattern = new RegExp(`#${escaped}\\s*\\[话题\\]#`, "u");
    const residueBeforeComponent = new RegExp(
      `(?:#?${escaped}\\s*)+(?=#${escaped}\\s*\\[话题\\]#)`,
      "gu",
    );
    const view = element.ownerDocument?.defaultView || window;
    const walker = element.ownerDocument.createTreeWalker(
      element,
      view.NodeFilter.SHOW_TEXT,
    );
    let changed = false;
    let node = walker.nextNode();
    while (node) {
      const value = node.nodeValue || "";
      if (componentPattern.test(value)) {
        const cleaned = value.replace(residueBeforeComponent, "");
        if (cleaned !== value) {
          node.nodeValue = cleaned;
          changed = true;
        }
      }
      node = walker.nextNode();
    }

    // Xiaohongshu usually renders the selected topic as its own inline node,
    // while the search query remains in the preceding text node. Only trim a
    // matching suffix immediately before an exact topic component so normal
    // mentions in the article body are never touched.
    const components = Array.from(element.querySelectorAll("*"))
      .filter((candidate) => componentPattern.test(buttonText(candidate)))
      .sort(
        (left, right) =>
          left.querySelectorAll("*").length -
          right.querySelectorAll("*").length,
      );
    const component = components[0];
    if (component) {
      const texts = [];
      const allText = element.ownerDocument.createTreeWalker(
        element,
        view.NodeFilter.SHOW_TEXT,
      );
      let current = allText.nextNode();
      while (current) {
        texts.push(current);
        current = allText.nextNode();
      }
      const componentTextIndex = texts.findIndex((textNode) =>
        component.contains(textNode),
      );
      for (let index = componentTextIndex - 1; index >= 0; index -= 1) {
        const textNode = texts[index];
        const value = textNode?.nodeValue || "";
        if (!value.trim() && index > componentTextIndex - 3) continue;
        const cleaned = value.replace(
          new RegExp(`(?:#?${escaped}\\s*)+$`, "u"),
          "",
        );
        if (cleaned !== value) {
          textNode.nodeValue = cleaned;
          changed = true;
        }
        break;
      }
    }
    if (changed) {
      element.dispatchEvent(new view.InputEvent("input", { bubbles: true }));
    }
    return changed;
  }

  function assertSafeAction(element) {
    if (isForbiddenAction(element) || !isDraftAction(element))
      throw new Error("FORMAL_PUBLISH_ACTION_FORBIDDEN");
  }

  function findPublishButton() {
    const candidates = queryAllDeep('button,[role="button"]')
      .filter(visible)
      .filter((element) => forbiddenAction.test(buttonText(element)));
    return candidates.length === 1 ? candidates[0] : null;
  }

  function pageText() {
    return collectRoots()
      .map((root) =>
        root.nodeType === Node.DOCUMENT_NODE
          ? root.body?.innerText || ""
          : root.textContent || "",
      )
      .join("\n");
  }

  globalThis.GdXhsAdapter = {
    forbiddenAction,
    allowedDraftAction,
    savedSignal,
    publishedSignal,
    verificationSignal,
    visible,
    findFileInput,
    findImageDropZone,
    dropFiles,
    findImageUploadTab,
    activate,
    findTitleInput,
    findBodyInput,
    findTopicButton,
    findTopicCandidate,
    hasExactTopicComponent,
    removeTopicQueryResidue,
    findDraftButton,
    isDraftAction,
    isForbiddenAction,
    assertSafeAction,
    findPublishButton,
    pageText,
    editorDiagnostics,
  };
})();
