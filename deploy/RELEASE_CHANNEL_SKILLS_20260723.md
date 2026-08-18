# 渠道 Skill 独立路由上线说明

本版本将官网与公众号从“共用一篇核心文章”改为独立渠道生产：

- 官网：`gd-market-guanwang-auto@1.0.0`
- 公众号：`gd-market-gzh-auto@1.0.0`
- 双选：资料核验一次，文章、排版、图片、质检和草稿结果分别生成
- 每个任务保存 Skill 名称、版本和规则摘要

## `.env` 一次性迁移

真实 Key 可以直接配置在服务器本地 `.env`，不需要流水线。本版本开始 `.env` 不再由 Git 跟踪，也不会复制进 Docker 镜像。

如果服务器上的 `.env` 以前已经被 Git 跟踪且有本地修改，首次更新前执行：

```bash
cd /opt/geekdance-ai-ops
install -m 600 .env /tmp/geekdance-aiops.env.backup
git restore --source=HEAD --staged --worktree .env
git pull --ff-only
install -m 600 /tmp/geekdance-aiops.env.backup .env
```

确认以下正式模式已由运维按实际情况配置，值不要粘贴到聊天或提交到 Git：

```text
CONTENT_ENGINE_MODE=openrouter
IMAGE_PROVIDER_MODE=openrouter
OPENROUTER_TEXT_API_KEY=真实文本Key
OPENROUTER_IMAGE_API_KEY=真实图片Key
OPENROUTER_TEXT_MODEL=openai/gpt-5.6-sol
OPENROUTER_IMAGE_MODEL=openai/gpt-5.4-image-2
```

若文本和图片共用一个 Key，也可以只配置兼容项 `OPENROUTER_API_KEY`。

## 不使用流水线的部署命令

项目使用 `.env.production` 时：

```bash
pnpm prod:check
pnpm prod:deploy
```

项目明确使用 `.env` 时：

```bash
chmod 600 .env
ENV_FILE=.env pnpm prod:check
ENV_FILE=.env pnpm prod:deploy
```

部署脚本会完成数据库兼容迁移，为历史库增加 `template_versions` 字段。只会创建渠道草稿，不包含正式发布或公众号群发接口。
