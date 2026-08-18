(() => {
  const adapter = globalThis.GdXhsAdapter;
  const articleAdapter = globalThis.GdArticlePlatformAdapter;
  const wait = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

  function heartbeat(taskId, channel = "xiaohongshu", deliveryKind) {
    return chrome.runtime.sendMessage({
      type: "TASK_HEARTBEAT",
      taskId,
      channel,
      deliveryKind,
    });
  }

  function deliveryMode(task) {
    return task.deliveryMode || task.payload?.deliveryMode || "draft";
  }

  function assertDeliverySafety(task) {
    const mode = deliveryMode(task);
    if (mode === "draft") {
      if (
        task.payload?.safety?.draftOnly !== true ||
        task.payload?.safety?.formalPublishForbidden !== true
      )
        throw new Error("DRAFT_ONLY_GUARD_MISSING");
      return;
    }
    if (
      task.deliveryKind !== "multi_account" ||
      task.payload?.safety?.formalPublishAuthorized !== true ||
      !task.payload?.safety?.authorizationBatchId ||
      task.payload?.safety?.authorizationItemId !== task.id ||
      task.payload?.reviewedContentFingerprint !== task.contentFingerprint
    )
      throw new Error("FORMAL_PUBLISH_AUTHORIZATION_INVALID");
  }

  function discoverAccount() {
    const channel =
      location.hostname === "creator.xiaohongshu.com"
        ? "xiaohongshu"
        : articleAdapter?.platform?.();
    const pageText = document.body?.innerText || "";
    if (
      !channel ||
      /扫码登录|登录后继续|请先登录|验证码|安全验证/.test(pageText)
    )
      return { ok: false, errorCode: "PLATFORM_LOGIN_REQUIRED" };
    const profileSelectors = {
      xiaohongshu: [
        'a[href*="/user/profile/"]',
        'a[href*="/profile"]',
        '[class*="userName"]',
        '[class*="username"]',
      ],
      zhihu: [
        'a[href*="/people/"]',
        '[class*="ProfileHeader-name"]',
        '[class*="UserLink-link"]',
      ],
      toutiao: [
        'a[href*="/profile"]',
        'a[href*="/account"]',
        '[class*="user-name"]',
        '[class*="account-name"]',
      ],
      baijiahao: [
        'a[href*="/account"]',
        'a[href*="/user"]',
        '[class*="user-name"]',
        '[class*="account-name"]',
      ],
      linkedin: [
        '[data-test-global-nav-profile-link]',
        '[data-control-name="identity_profile_photo"]',
        '[class*="profile-rail-card"] a[href]',
        'nav a[href*="/in/"]',
        'nav a[href*="/company/"]',
      ],
    };
    const candidates = (profileSelectors[channel] || [])
      .flatMap((selector) => [...document.querySelectorAll(selector)])
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
    const profile = candidates.find((element) => {
      const text = (
        element.innerText ||
        element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        element.querySelector?.("img")?.alt ||
        ""
      ).trim();
      return text.length > 0 && text.length <= 120;
    });
    const profileUrl = profile?.href || undefined;
    const displayName = (
      profile?.innerText ||
      profile?.getAttribute?.("aria-label") ||
      profile?.getAttribute?.("title") ||
      profile?.querySelector?.("img")?.alt ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    if (!profile || !displayName)
      return {
        ok: false,
        errorCode: "PLATFORM_ACCOUNT_IDENTITY_NOT_VISIBLE",
      };
    const publicAccountId =
      profile.getAttribute?.("data-user-id") ||
      profile.getAttribute?.("data-account-id") ||
      "";
    return {
      ok: true,
      channel,
      displayName,
      profileUrl,
      accountIdentity:
        profileUrl ||
        (publicAccountId
          ? `${channel}:${publicAccountId}`
          : `${channel}:${displayName}`),
    };
  }

  function dataUrlToFile(dataUrl, name) {
    const [header, encoded] = dataUrl.split(",", 2);
    const mime = header.match(/^data:([^;]+);base64$/)?.[1];
    if (!mime || !encoded) throw new Error("IMAGE_DATA_INVALID");
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1)
      bytes[index] = binary.charCodeAt(index);
    return new File([bytes], name, { type: mime });
  }

  function imageExtension(dataUrl) {
    const mime = dataUrl.match(/^data:([^;]+);base64,/)?.[1];
    if (mime === "image/png") return "png";
    if (mime === "image/webp") return "webp";
    return "jpg";
  }

  function setNativeValue(element, value) {
    const view = element.ownerDocument?.defaultView || window;
    if (element instanceof view.HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(
        view.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(element, value);
    } else if (element instanceof view.HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(
        view.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(element, value);
    } else {
      element.focus();
      const selection = element.ownerDocument.getSelection();
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
      const paragraphs = value.split(/\n{2,}/).map((item) => item.trim());
      let inserted = false;
      if (element.ownerDocument.execCommand) {
        element.ownerDocument.execCommand("delete", false);
        for (const [index, paragraph] of paragraphs.entries()) {
          if (index) {
            element.ownerDocument.execCommand("insertParagraph", false);
            element.ownerDocument.execCommand("insertParagraph", false);
          }
          inserted =
            element.ownerDocument.execCommand("insertText", false, paragraph) ||
            inserted;
        }
      }
      if (!inserted) {
        element.replaceChildren();
        for (const paragraph of paragraphs) {
          const node = element.ownerDocument.createElement("p");
          node.textContent = paragraph || " ";
          element.append(node);
        }
      }
    }
    element.dispatchEvent(
      new view.InputEvent("input", { bubbles: true, data: value }),
    );
    element.dispatchEvent(new view.Event("change", { bubbles: true }));
    element.dispatchEvent(new view.Event("blur", { bubbles: true }));
  }

  function placeCursorAtEnd(element) {
    element.focus();
    const selection = element.ownerDocument.getSelection();
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  async function addRealTopics(bodyInput, topics) {
    const selected = [];
    const failed = [];
    placeCursorAtEnd(bodyInput);
    // Keep the topic components in one trailing paragraph. Creating a new
    // paragraph for every topic makes Xiaohongshu render them vertically.
    bodyInput.ownerDocument.execCommand?.("insertParagraph", false);
    for (const topic of topics) {
      placeCursorAtEnd(bodyInput);
      const topicButton = await waitFor(() => adapter.findTopicButton(), 5_000);
      if (!topicButton) {
        failed.push(topic);
        break;
      }
      adapter.activate(topicButton);
      await wait(300);
      bodyInput.ownerDocument.execCommand?.("insertText", false, topic);
      const candidate = await waitFor(
        () => adapter.findTopicCandidate(topic),
        4_000,
      );
      if (!candidate) {
        failed.push(topic);
        break;
      }
      adapter.activate(candidate);
      await wait(350);
      if (!adapter.hasExactTopicComponent(bodyInput, topic)) {
        failed.push(topic);
        break;
      }
      adapter.removeTopicQueryResidue(bodyInput, topic);
      selected.push(topic);
      bodyInput.ownerDocument.execCommand?.("insertText", false, "  ");
      await wait(250);
    }
    return { selected, failed };
  }

  async function waitFor(match, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const value = match();
      if (value) return value;
      await wait(500);
    }
    return null;
  }

  function setRichHtml(element, html, imageDataUrls) {
    const view = element.ownerDocument.defaultView || window;
    const parsed = new DOMParser().parseFromString(html, "text/html");
    [...parsed.querySelectorAll("script,style,iframe,object,embed")].forEach(
      (node) => node.remove(),
    );
    [...parsed.querySelectorAll("img")].forEach((image, index) => {
      if (imageDataUrls[index]) image.src = imageDataUrls[index];
      image.removeAttribute("srcset");
      image.style.maxWidth = "100%";
      image.style.height = "auto";
    });
    element.focus();
    const selection = element.ownerDocument.getSelection();
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const safeHtml = parsed.body.innerHTML;
    let inserted = false;
    if (element.ownerDocument.execCommand) {
      element.ownerDocument.execCommand("delete", false);
      inserted = element.ownerDocument.execCommand(
        "insertHTML",
        false,
        safeHtml,
      );
    }
    if (!inserted) element.innerHTML = safeHtml;
    element.dispatchEvent(
      new view.InputEvent("input", {
        bubbles: true,
        inputType: "insertFromPaste",
        data: null,
      }),
    );
    element.dispatchEvent(new view.Event("change", { bubbles: true }));
    return {
      textProbe: (parsed.body.textContent || "")
        .replace(/\s+/g, "")
        .slice(0, 24),
      imageCount: parsed.querySelectorAll("img").length,
    };
  }

  function editableValue(element) {
    return "value" in element ? String(element.value || "") : element.innerText;
  }

  function withLinkedInHashtags(html, tags) {
    if (!Array.isArray(tags) || tags.length === 0) return html;
    const parsed = new DOMParser().parseFromString(html, "text/html");
    if (parsed.querySelector('[data-gd-linkedin-hashtags="true"]'))
      return parsed.body.innerHTML;
    const normalized = [
      ...new Set(
        tags
          .map((tag) => String(tag || "").replace(/^#+/, "").trim())
          .filter(Boolean),
      ),
    ].slice(0, 5);
    if (!normalized.length) return parsed.body.innerHTML;
    const paragraph = parsed.createElement("p");
    paragraph.dataset.gdLinkedinHashtags = "true";
    paragraph.textContent = normalized.map((tag) => `#${tag}`).join(" ");
    parsed.body.append(paragraph);
    return parsed.body.innerHTML;
  }

  async function runArticleTask(task) {
    const channel = task.channel || task.payload?.channel;
    if (!articleAdapter || articleAdapter.platform() !== channel)
      throw new Error("ARTICLE_PLATFORM_MISMATCH");
    assertDeliverySafety(task);
    if (articleAdapter.verificationSignal.test(articleAdapter.pageText()))
      return {
        status: "manual_review",
        errorCode: "PLATFORM_LOGIN_OR_VERIFICATION_REQUIRED",
        message: "平台要求登录或安全验证，扩展已安全停止。",
      };
    const article = task.payload?.article;
    if (!article?.title || !article?.html)
      throw new Error("ARTICLE_PAYLOAD_INVALID");
    const titleInput = await waitFor(
      () => articleAdapter.findTitleInput(),
      20_000,
    );
    const bodyInput = await waitFor(
      () => articleAdapter.findBodyInput(),
      20_000,
    );
    if (!titleInput || !bodyInput)
      return {
        status: "manual_review",
        errorCode: "ARTICLE_EDITOR_FIELDS_MISSING",
        message:
          "未识别到唯一的标题或正文编辑器，请确认已登录并打开文章创作页。",
      };
    setNativeValue(titleInput, article.title);
    const articleHtml =
      channel === "linkedin"
        ? withLinkedInHashtags(article.html, article.tags)
        : article.html;
    const inserted = setRichHtml(
      bodyInput,
      articleHtml,
      task.imageDataUrls || [],
    );
    await heartbeat(task.id, channel, task.deliveryKind);
    await wait(1_500);
    const normalizedTitle = editableValue(titleInput).replace(/\s+/g, "");
    const normalizedBody = editableValue(bodyInput).replace(/\s+/g, "");
    const retainedImages = bodyInput.querySelectorAll("img").length;
    if (
      !normalizedTitle.includes(article.title.replace(/\s+/g, "")) ||
      !inserted.textProbe ||
      !normalizedBody.includes(inserted.textProbe) ||
      retainedImages < inserted.imageCount
    )
      return {
        status: "manual_review",
        errorCode: "ARTICLE_EDITOR_STATE_NOT_RETAINED",
        platformUrl: location.href,
        message:
          "平台编辑器没有完整保留标题、正文或配图，扩展已停止保存，请人工检查页面。",
      };
    if (deliveryMode(task) === "publish") {
      const publishButton = articleAdapter.findPublishButton();
      if (!publishButton)
        return {
          status: "manual_review",
          errorCode: "FORMAL_PUBLISH_BUTTON_NOT_UNIQUE",
          platformUrl: location.href,
          message: "没有识别到唯一的正式发布按钮，扩展已安全停止。",
        };
      const successAlreadyVisible = articleAdapter.publishedSignal.test(
        articleAdapter.pageText(),
      );
      articleAdapter.activate(publishButton);
      const published = await waitFor(
        () =>
          !successAlreadyVisible &&
          articleAdapter.publishedSignal.test(articleAdapter.pageText()),
        15_000,
      );
      if (!published)
        return {
          status: "ambiguous",
          errorCode: "FORMAL_PUBLISH_SIGNAL_MISSING",
          platformUrl: location.href,
          message:
            "已点击唯一发布按钮，但未检测到明确成功信号，请人工核对，系统不会自动重试。",
        };
      return {
        status: "published",
        published: true,
        successSignal: "页面显示发布成功",
        platformUrl: location.href,
        message: "文章已正式发布。",
      };
    }
    const draftButton = articleAdapter.findDraftButton();
    if (!draftButton)
      return {
        status: "filled",
        draftSaved: false,
        platformUrl: location.href,
        message:
          "标题、正文和配图已填写；页面没有唯一可确认的草稿按钮，请人工保存草稿。",
      };
    const saveSignalAlreadyVisible = articleAdapter.savedSignal.test(
      articleAdapter.pageText(),
    );
    articleAdapter.activate(draftButton);
    const saved = await waitFor(
      () =>
        !saveSignalAlreadyVisible &&
        articleAdapter.savedSignal.test(articleAdapter.pageText()),
      10_000,
    );
    if (!saved)
      return {
        status: "ambiguous",
        errorCode: "DRAFT_SAVE_SIGNAL_MISSING",
        platformUrl: location.href,
        message:
          "已点击明确的保存草稿按钮，但未检测到成功提示，请人工核对草稿箱，系统不会自动重试。",
      };
    return {
      status: "drafted",
      draftSaved: true,
      saveSignal: "页面显示草稿保存成功",
      platformUrl: location.href,
      message: "文章已保存到平台草稿箱。",
    };
  }

  async function runTask(task) {
    if ((task.channel || task.payload?.channel) !== "xiaohongshu")
      return runArticleTask(task);
    assertDeliverySafety(task);
    if (adapter.verificationSignal.test(adapter.pageText()))
      return {
        status: "manual_review",
        errorCode: "XHS_SECURITY_VERIFICATION_REQUIRED",
        message: "小红书要求完成安全验证，请人工处理后重新创建上传任务。",
      };

    await heartbeat(task.id, "xiaohongshu", task.deliveryKind);
    // The creator page can expose a hidden/ shared image file input while
    // still defaulting to the video workflow. Always select “上传图文” first;
    // otherwise assigning files can be ignored and the title/body editor
    // never mounts.
    const imageTab = await waitFor(() => adapter.findImageUploadTab(), 15_000);
    if (!imageTab)
      return {
        status: "manual_review",
        errorCode: "XHS_IMAGE_TAB_MISSING",
        message: "没有找到小红书“上传图文”入口，扩展已安全停止。",
      };
    adapter.activate(imageTab);
    await wait(1_500);
    const fileInput = await waitFor(() => {
      try {
        return adapter.findFileInput();
      } catch {
        return null;
      }
    }, 15_000);
    if (!fileInput)
      return {
        status: "manual_review",
        errorCode: "XHS_EDITOR_NOT_READY",
        message:
          "没有找到唯一的图片上传控件，请确认已登录并打开图文笔记编辑页。",
      };

    if (!Array.isArray(task.imageDataUrls) || task.imageDataUrls.length === 0)
      return {
        status: "failed",
        errorCode: "XHS_IMAGES_MISSING",
        message: "小红书图文草稿没有可上传图片，扩展未进入创作页。",
      };
    const files = task.imageDataUrls.map((dataUrl, index) =>
      dataUrlToFile(
        dataUrl,
        `geekdance-${index + 1}.${imageExtension(dataUrl)}`,
      ),
    );
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    fileInput.files = transfer.files;
    fileInput.dispatchEvent(new Event("input", { bubbles: true }));
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    await heartbeat(task.id, "xiaohongshu", task.deliveryKind);
    await wait(4_000);

    // Some Xiaohongshu builds bind the uploader to the drop zone instead of
    // the hidden input's synthetic change event. Use the same File objects in
    // a drop event only when the editor has not mounted after the first path.
    let earlyTitle = null;
    try {
      earlyTitle = adapter.findTitleInput();
    } catch {
      const dropZone = adapter.findImageDropZone();
      if (dropZone) {
        adapter.dropFiles(dropZone, transfer);
        await wait(5_000);
      }
    }

    if (adapter.verificationSignal.test(adapter.pageText()))
      return {
        status: "manual_review",
        errorCode: "XHS_SECURITY_VERIFICATION_REQUIRED",
        message: "上传图片后触发了小红书安全验证。",
      };

    const titleInput =
      earlyTitle ||
      (await waitFor(() => {
        try {
          return adapter.findTitleInput();
        } catch {
          return null;
        }
      }, 20_000));
    const bodyInput = await waitFor(() => {
      try {
        return adapter.findBodyInput();
      } catch {
        return null;
      }
    }, 15_000);
    if (!titleInput || !bodyInput) {
      const diagnostics = adapter.editorDiagnostics(fileInput);
      return {
        status: "manual_review",
        errorCode: "XHS_EDITOR_FIELDS_MISSING",
        message: `小红书编辑器未进入可填写状态，扩展已安全停止。诊断：${JSON.stringify(diagnostics)}`,
      };
    }
    const note = task.payload.note;
    const body = note.body;
    setNativeValue(titleInput, note.title);
    setNativeValue(bodyInput, body);
    const topics = await addRealTopics(bodyInput, note.hashtags);
    await heartbeat(task.id, "xiaohongshu", task.deliveryKind);
    await wait(1_500);
    if (deliveryMode(task) === "publish") {
      const publishButton = adapter.findPublishButton();
      if (!publishButton)
        return {
          status: "manual_review",
          errorCode: "FORMAL_PUBLISH_BUTTON_NOT_UNIQUE",
          platformUrl: location.href,
          message: "没有识别到唯一的正式发布按钮，扩展已安全停止。",
        };
      const successAlreadyVisible = adapter.publishedSignal.test(
        adapter.pageText(),
      );
      adapter.activate(publishButton);
      const published = await waitFor(
        () =>
          !successAlreadyVisible &&
          adapter.publishedSignal.test(adapter.pageText()),
        15_000,
      );
      if (!published)
        return {
          status: "ambiguous",
          errorCode: "FORMAL_PUBLISH_SIGNAL_MISSING",
          platformUrl: location.href,
          message:
            "已点击唯一发布按钮，但未检测到明确成功信号，请人工核对，系统不会自动重试。",
        };
      return {
        status: "published",
        published: true,
        successSignal: "页面显示发布成功",
        platformUrl: location.href,
        message: "小红书笔记已正式发布。",
      };
    }
    if (task.deliveryKind === "multi_account" && topics.failed.length === 0) {
      const xhsDraftButton = adapter.findDraftButton();
      if (!xhsDraftButton)
        return {
          status: "filled",
          draftSaved: false,
          topicsSelected: topics.selected,
          topicsFailed: topics.failed,
          platformUrl: location.href,
          message:
            "图片、标题、正文和话题已填写，但没有识别到唯一的草稿按钮，请人工保存。",
        };
      const saveSignalAlreadyVisible = adapter.savedSignal.test(
        adapter.pageText(),
      );
      adapter.activate(xhsDraftButton);
      const saved = await waitFor(
        () =>
          !saveSignalAlreadyVisible &&
          adapter.savedSignal.test(adapter.pageText()),
        10_000,
      );
      if (!saved)
        return {
          status: "ambiguous",
          errorCode: "DRAFT_SAVE_SIGNAL_MISSING",
          platformUrl: location.href,
          message:
            "已点击唯一草稿按钮，但未检测到明确成功提示，请人工核对，系统不会自动重试。",
        };
      return {
        status: "drafted",
        draftSaved: true,
        saveSignal: "页面显示草稿保存成功",
        topicsSelected: topics.selected,
        topicsFailed: topics.failed,
        platformUrl: location.href,
        message: "小红书内容已保存到目标账号草稿箱。",
      };
    }
    return {
      status: "filled",
      draftSaved: false,
      topicsSelected: topics.selected,
      topicsFailed: topics.failed,
      platformUrl: location.href,
      message: topics.failed.length
        ? `图片和内容已填写，已添加 ${topics.selected.length} 个横向话题；其余话题请核对后人工点击“暂存离开”。`
        : "图片、标题、正文和横向话题已填写完成，请在小红书页面人工点击“暂存离开”。",
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "GD_XHS_CONTENT_READY") {
      sendResponse({ ready: true });
      return false;
    }
    if (message?.type === "GD_DISCOVER_ACCOUNT") {
      sendResponse(discoverAccount());
      return false;
    }
    if (message?.type !== "GD_XHS_UPLOAD_TASK") return undefined;
    runTask(message.task)
      .then(async (result) => {
        // Long-running editor work can outlive Chrome's original tab-message
        // response channel. Report through a second runtime message as well so
        // a completed draft is never downgraded to an empty/ambiguous result.
        await chrome.runtime
          .sendMessage({
            type: "CONTENT_TASK_RESULT",
            taskId: message.task.id,
            result,
          })
          .catch(() => undefined);
        sendResponse({ ok: true, result });
      })
      .catch((error) =>
        Promise.resolve({
          status: "manual_review",
          errorCode: "XHS_EXTENSION_FAILED_SAFE",
          message: error instanceof Error ? error.message : "扩展安全停止",
        }).then(async (result) => {
          await chrome.runtime
            .sendMessage({
              type: "CONTENT_TASK_RESULT",
              taskId: message.task.id,
              result,
            })
            .catch(() => undefined);
          sendResponse({
            ok: false,
            result,
          });
        }),
      );
    return true;
  });
})();
