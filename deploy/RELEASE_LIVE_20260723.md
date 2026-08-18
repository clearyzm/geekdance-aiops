# 真实功能上线说明（2026-07-23）

本版本把生产环境从 Mock 切换为真实内容与草稿链路，仍然只创建官网/公众号草稿，不包含官网正式发布或公众号群发接口。

## 必填配置变更

运维在服务器 `/opt/geekdance-ai-ops/.env.production` 中补齐或更新：

```dotenv
CONTENT_ENGINE_MODE=openrouter
IMAGE_PROVIDER_MODE=openrouter
OPENROUTER_TEXT_API_KEY=请填写
OPENROUTER_IMAGE_API_KEY=请填写
OPENROUTER_TEXT_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_IMAGE_BASE_URL=https://openrouter.ai
OPENROUTER_TEXT_MODEL=openai/gpt-5.6-sol
OPENROUTER_IMAGE_MODEL=openai/gpt-5.4-image-2
OPENROUTER_TEXT_TIMEOUT_MS=240000

ASSET_PUBLIC_BASE_URL=https://aiops.geekdance.cn/api/public/assets
ASSET_PUBLIC_SECRET=请生成至少32字节随机值

OFFICIAL_PUBLISHER_MODE=live
OFFICIAL_ALLOW_PROD=true
OFFICIAL_IMAGE_ALLOWED_HOSTS=home.geekdance.app,.aliyuncs.com,.geekdance.cn,aiops.geekdance.cn

WECHAT_PUBLISHER_MODE=live
WECHAT_ALLOW_PROD=true
WECHAT_IMAGE_ALLOWED_HOSTS=home.geekdance.app,.aliyuncs.com,.geekdance.cn,aiops.geekdance.cn
DEPLOY_CONFIRM_LIVE_DRAFTS=true
```

兼容旧的单一 `OPENROUTER_API_KEY`，但生产环境建议文本和图片分别配置。真实密钥不得提交到 Codeup。

生成签名密钥：

```bash
openssl rand -base64 48
```

## 上线命令

```bash
cd /opt/geekdance-ai-ops
git pull --ff-only
chmod 0600 .env.production
./deploy/scripts/preflight.sh
./deploy/scripts/deploy.sh 1.0.0-live
./deploy/scripts/healthcheck.sh
```

## 验收顺序

1. 管理员登录渠道管理页，确认官网、公众号、OpenRouter 显示已连接。
2. 用 GeekHome 素材创建一篇带“自动化验收”标识的官网草稿。
3. 用同一内容创建公众号草稿，确认正文不存在外链图片。
4. 选择 AI 生图创建双渠道草稿，确认三张图进入内容资产并能正常预览。
5. 检查两个渠道后台只出现草稿，没有正式发布或群发。
6. 先运行 `./deploy/scripts/cleanup-test-data.sh` 查看命中数量；确认后再运行 `./deploy/scripts/cleanup-test-data.sh --confirm`。

清理脚本会先备份，只处理带明确测试标识的任务和关联素材，不删除 Logo、吉祥物与公众号宣传板。
