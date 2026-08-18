const status = document.querySelector("#status");
const check = document.querySelector("#check");

async function inspectConnection() {
  check.disabled = true;
  status.textContent = "正在检查连接…";
  try {
    const local = await chrome.runtime.sendMessage({ type: "LOCAL_STATUS" });
    if (!local?.configured) {
      status.textContent = "助手已安装，首次上传并填写时会自动启用。";
      return;
    }
    const result = await chrome.runtime.sendMessage({
      type: "CHECK_CONNECTION",
    });
    status.textContent = result?.ok
      ? "助手运行正常，可以从运营中心保存小红书、知乎、今日头条、百家号或 LinkedIn 的指定草稿。"
      : result?.error || "连接检查失败。";
  } catch (error) {
    status.textContent =
      error instanceof Error ? error.message : "连接检查失败。";
  } finally {
    check.disabled = false;
  }
}

check.addEventListener("click", () => void inspectConnection());
void inspectConnection();
