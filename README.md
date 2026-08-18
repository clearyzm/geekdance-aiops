# 极客跳动 AI 运营中心

面向极客跳动运营团队的内部内容生产与渠道草稿管理平台。当前已接入官网、公众号、小红书、知乎文章、今日头条图文和百家号图文六渠道的内容生产、人工复核、独立排版与草稿准备。

## 本地启动

1. 复制 `.env.example` 为 `.env`，在本机填写随机密码和临时管理员密码。
2. 确认 `.env` 里的 `DATABASE_URL` 和 `REDIS_URL` 指向宿主机 PostgreSQL / Redis。
3. 按 [Docker Run 启动说明](deploy/README_DOCKER_RUN.md) 构建镜像并用 `docker run` 启动 `app` 容器。
4. 访问 `http://localhost:3000`。

所有渠道功能均不正式发布。官网与公众号使用服务端草稿接口；小红书、知乎、今日头条和百家号由每位成员电脑上的公司版 Chrome 扩展复用当前已登录会话。小红书填写完成后由人工点击“暂存离开”；其他三平台只在识别到唯一草稿按钮时自动保存。LinkedIn 为禁用的预留模块。

## 生产能力与运行边界

- 生产环境使用 OpenRouter 真实检索/写作与 AI 生图、GeekHome 真实素材搜索、官网草稿接口和微信公众号官方草稿 API；本地开发仍可显式选择 Mock 模式做离线回归。
- 通识、行业、技术、趋势和公司运营内容可完成全文、配图决策、官网 HTML、公众号 HTML 与质量报告。
- 内容表单支持 PDF、DOCX、TXT、Markdown、PNG 与 JPG；文本类附件在服务端解析，图片附件在真实内容模式下进入视觉资料流程。附件具备账号归属校验，不能跨运营账号引用。
- 案例类请求会进入 `manual_review`，预留路由为 `xiaohongshu_case_workflow`，不会虚构客户或项目结果。
- 官网草稿适配器已通过真实草稿验收。生产写入必须同时满足 `OFFICIAL_ALLOW_PROD=true` 与任务 `confirmDraft=true`，请求载荷固定为 `status=draft`。
- 微信公众号使用官方 API，正文图片会逐张上传并替换外链；真实草稿需要把服务器固定出口 IP 加入微信白名单。
- 定时任务按 `Asia/Shanghai` 执行，可选择每日任意时间及官网、公众号或双渠道；新建与预置计划默认停用。
- 图片工坊支持 OpenRouter AI 生图、透明抠图、Image 2 人物背景融合、比例裁切、精确拼接、AI 创意拼接和官方 Logo 叠加；抠图与确定性处理在本地图片服务执行。
- `operationId` 提供幂等保护；每名成员最多同时运行 3 个活动任务。
- 管理员可创建、启停成员；首次登录的临时密码在后端强制修改。运营成员可进入渠道管理下载、连接或停用自己电脑上的多平台草稿助手。

## 多平台草稿助手内部分发

生产构建会把 `extensions/xiaohongshu-draft-uploader` 自动打包为 `/downloads/geekdance-multi-platform-draft-uploader.zip`。每位同事只需安装一次，即可复用小红书、知乎、今日头条和百家号的当前 Chrome 登录态。首次从任务详情保存任意扩展渠道时，网站会自动完成当前电脑连接，不需要复制令牌、接口地址或版本号。完整安装与安全说明见 [扩展文档](extensions/xiaohongshu-draft-uploader/README.md)。

## 安全模式与草稿验收

日常本地开发使用：

```dotenv
CONTENT_ENGINE_MODE=mock
OFFICIAL_PUBLISHER_MODE=mock
OFFICIAL_ALLOW_PROD=false
WECHAT_PUBLISHER_MODE=mock
WECHAT_ALLOW_PROD=false
IMAGE_PROVIDER_MODE=mock
```

生产环境按 `.env.production.example` 使用 `openrouter` / `live`，并通过 `*_ALLOW_PROD=true`、任务 `confirmDraft=true` 和部署确认门禁共同限制写入。系统不存在正式发布接口。

## 验证命令

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm test:stage5:mock
STAGE6_TEST_REMBG=true pnpm test:stage6:mock
pnpm test:stage7:mock
pnpm test:stage8:offline
docker ps
```

`test:stage7:mock` 覆盖双账号、首次改密后端门禁、管理员接口隔离、附件校验与证据追溯、跨账号数据隔离、双渠道独立产物、20 次并发幂等提交、只重试失败渠道和任意每日时间。脚本只产生本地 Mock 草稿，不调用外部渠道。

## 生产部署

第 8 阶段的 Ubuntu 生产部署工程位于 `docker-compose.production.yml` 和 `deploy/`。它只公开 80/443，包含 HTTPS、只读应用容器、资源限制、日志轮转、固定出口 IP 校验、加密备份、恢复、健康巡检与镜像回滚。完整流程见 `deploy/README_PRODUCTION.md`。
