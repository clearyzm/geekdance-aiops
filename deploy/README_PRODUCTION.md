# 极客跳动 AI 运营中心生产部署手册

本手册适用于 Ubuntu 24.04 LTS，项目目录固定为 `/opt/geekdance-ai-ops`，正式域名固定为 `aiops.geekdance.cn`。部署只提供官网和公众号“创建草稿”能力；代码中没有官网正式发布、公众号群发、小红书发布或 LinkedIn 发布接口。

## 1. 云资源门禁

上线前必须由基础设施管理员完成：

1. 为云主机绑定不会随重启变化的 EIP，或让它经过固定公网 NAT。仅仅“部署到云服务器”并不自动等于固定出口 IP。
2. 安全组与 UFW 只开放 SSH 管理来源、TCP 80 和 TCP 443。PostgreSQL、Redis、API、Web 和图片服务均不得公开端口。
3. 将 `aiops.geekdance.cn` 的 A 记录指向固定 EIP。没有稳定 IPv6 时不要添加 AAAA 记录。
4. 微信白名单应填写从 Worker 同网络实际测得的出口 IPv4，而不是云主机控制台中未经验证的地址。
5. 至少准备 4 vCPU、8 GiB RAM、80 GiB SSD；抠图首次运行会下载模型，应额外预留空间和网络时间。

## 2. 主机准备

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git openssl
sudo install -d -m 0750 -o geekdance -g docker /opt/geekdance-ai-ops
```

安装官方 Docker Engine 与 Compose 插件，把专用 `geekdance` 用户加入 `docker` 组。将私有仓库检出到 `/opt/geekdance-ai-ops`。不要把 SSH 私钥、API Key 或渠道密码放进仓库。

## 3. 生产配置与密钥

```bash
cd /opt/geekdance-ai-ops
cp .env.production.example .env.production
chmod 0600 .env.production
sudo install -d -m 0700 -o geekdance -g geekdance /etc/geekdance-ai-ops
openssl rand -base64 48 | sudo tee /etc/geekdance-ai-ops/backup.key >/dev/null
sudo chown geekdance:geekdance /etc/geekdance-ai-ops/backup.key
sudo chmod 0400 /etc/geekdance-ai-ops/backup.key
```

管理员只在服务器本地编辑 `.env.production`。密码建议由密码管理器生成；`DATABASE_URL` 和 `REDIS_URL` 中的密码必须做 URL 编码。正式环境配置为：

```dotenv
CONTENT_ENGINE_MODE=openai
OPENAI_API_KEY=请在服务器填写真实的 OpenAI 官方 API Key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_TEXT_MODEL=gpt-5.6-sol
OPENAI_RESEARCH_FALLBACK_MODEL=gpt-5.4
OPENAI_REASONING_EFFORT=medium
OPENAI_IMAGE_BASE_URL=https://api.openai.com/v1
OPENAI_IMAGE_MODEL=gpt-image-2
OPENAI_IMAGE_ALLOWED_HOSTS=api.openai.com,.openai.com,.oaistatic.com
IMAGE_PROVIDER_MODE=openai
OFFICIAL_PUBLISHER_MODE=live
OFFICIAL_ALLOW_PROD=true
WECHAT_PUBLISHER_MODE=live
WECHAT_ALLOW_PROD=true
DEPLOY_CONFIRM_LIVE_DRAFTS=true
```

文本研究和文章生成均优先使用 `gpt-5.6-sol`。只有 5.6 的托管 Web Search 明确不可用时，研究阶段才使用 `OPENAI_RESEARCH_FALLBACK_MODEL`。图片生成使用 OpenAI 官方 Images API 的 `gpt-image-2`；默认复用 `OPENAI_API_KEY`，如需独立管理图片额度，可额外配置 `OPENAI_IMAGE_API_KEY`。OpenRouter 图片配置只作为显式回退保留，正常部署不依赖它。

`BOOTSTRAP_ADMIN_PASSWORD` 只用于数据库中不存在管理员时的首次初始化；管理员首次登录仍会被强制修改密码。后续修改该环境值不会覆盖数据库中的现有密码。

## 4. DNS、TLS 与首次部署

确认 A 记录已经在公网解析到本机 EIP，且 80 端口没有被占用后：

```bash
cd /opt/geekdance-ai-ops
./deploy/scripts/bootstrap-tls.sh
./deploy/scripts/preflight.sh
./deploy/scripts/deploy.sh
```

TLS 使用 Let's Encrypt。HTTP 只保留 ACME 验证并跳转 HTTPS；HSTS 初始为一天，稳定运行后再评估延长。部署脚本会构建带发布标识的四个应用镜像，等待完整健康检查；升级失败时自动切回上一组镜像。数据库迁移为向前兼容迁移，不会在代码回滚时自动降级。

访问 `https://aiops.geekdance.cn`，使用首位管理员登录并立即修改临时密码。先运行健康检查，再用一篇带“自动化验收”标识的文章验证两个草稿箱，绝不点击正式发布。

## 5. 固定出口 IP 与渠道草稿验收

```bash
./deploy/scripts/check-egress-ip.sh
```

脚本从与 Worker 相同的 Docker 后端网络访问公网，并要求结果与 `EXPECTED_EGRESS_IPV4` 完全一致。校验通过后，才把该 IPv4 加入微信白名单。

真实草稿验收必须由管理员在维护窗口逐个渠道开启。一个渠道只有同时满足以下三项才能通过部署门禁：

- 对应 `*_PUBLISHER_MODE=live`；
- 对应 `*_ALLOW_PROD=true`；
- `DEPLOY_CONFIRM_LIVE_DRAFTS=true`。

开启后重新运行 `preflight.sh` 与 `deploy.sh`，只创建带“自动化验收”标识、可删除的草稿。确认完成后可以保留草稿模式，但系统始终不具备正式发布接口。

## 6. 日常发布与回滚

```bash
# 自动生成发布时间戳和 Git 短哈希
./deploy/scripts/deploy.sh

# 或指定审计友好的版本号
./deploy/scripts/deploy.sh 1.0.0

# 回到上一组本地镜像
./deploy/scripts/rollback.sh
```

部署前会先做一致性加密备份。回滚只切换应用镜像，不回退 PostgreSQL 数据；只有确认数据确实需要回退时，才使用恢复脚本。

确认真实草稿验收完成后，可先预览并清理历史测试数据：

```bash
./deploy/scripts/cleanup-test-data.sh
./deploy/scripts/cleanup-test-data.sh --confirm
```

第二条命令会先创建完整备份，只删除标题、主题或元数据中带明确测试标识的任务及其关联素材；Logo、吉祥物和公众号宣传板不会被删除。

## 7. 备份、恢复与恢复演练

```bash
./deploy/scripts/backup.sh
./deploy/scripts/restore.sh --confirm /var/backups/geekdance-ai-ops/daily/backup-YYYYMMDDTHHMMSSZ.tar.gz.enc
```

备份脚本会短暂停止 API 和 Worker，依次备份 PostgreSQL、Redis 持久数据和素材卷，再使用 AES-256-CBC、PBKDF2 与独立密钥加密。默认保留每日 7 天、每周 28 天、每月 183 天。归档只包含业务数据与发布标识，不包含 `.env.production` 或备份密钥。

每月至少在隔离服务器执行一次恢复演练。生产机上的本地备份不能替代异地备份；取得公司 OSS 的实际 Endpoint、Bucket、RAM 权限和生命周期规则后，应由基础设施侧把 `.enc` 与 `.sha256` 文件同步到只写备份前缀。不要把加密密钥与归档放在同一 Bucket 或同一主机备份中。

### 素材显示“源文件缺失”

该状态表示 PostgreSQL 中仍有素材记录，但记录对应的文件既不在 `/data/assets`，也没有数据库灾备副本。新素材以公司 OSS 为主存储，同时写入 PostgreSQL 灾备副本和本地缓存；容器或 Docker 卷重建不会再造成新素材丢失。生产环境必须配置 OSS，并固定本地缓存目录：

```dotenv
ASSET_HOST_DIR=/var/lib/geekdance-ai-ops/assets
```

先确认当前目录和历史卷，不要删除任何疑似旧卷：

```bash
find /var/lib/geekdance-ai-ops/assets -maxdepth 1 -type f | head
docker volume ls --format '{{.Name}}' | grep -E 'asset|geekdance'
docker compose --env-file .env.production -f docker-compose.production.yml config | grep -A5 '/data/assets'
```

如果找到包含历史文件的旧卷，先执行 `./deploy/scripts/backup.sh`，停止会写入素材的服务，再把旧卷文件复制到固定目录。将下面的 `OLD_ASSET_VOLUME` 替换为已经核实的旧卷名称：

```bash
docker compose --env-file .env.production -f docker-compose.production.yml stop api worker image-worker
docker run --rm \
  -v OLD_ASSET_VOLUME:/from:ro \
  -v /var/lib/geekdance-ai-ops/assets:/to \
  alpine:3.20 sh -ec 'cp -a /from/. /to/'
docker compose --env-file .env.production -f docker-compose.production.yml up -d image-worker api worker
./deploy/scripts/healthcheck.sh
```

日常执行 `deploy.sh` 时会自动尝试从默认旧卷
`geekdance-ai-ops-prod_asset_data` 复制尚未迁移的文件，并保留旧卷不变。
如历史卷使用了其他名称，部署前设置 `ASSET_LEGACY_VOLUME_NAME`。

如果没有旧卷，只能从备份或原始上传文件恢复。`restore.sh` 会同时恢复 PostgreSQL、Redis 和整个素材卷，属于全量数据回退；不要仅为恢复图片直接在生产机执行，必须先确认备份时间点并在隔离环境演练。

## 8. 定时健康检查和证书续期

```bash
sudo ./deploy/scripts/install-systemd.sh
systemctl list-timers 'geekdance-ops-*'
journalctl -u geekdance-ops-health.service
```

定时器执行：

- 每 5 分钟检查容器、PostgreSQL、Redis、素材卷、HTTPS、磁盘和出口 IP；
- 每天 02:30 执行加密备份；
- 每天两次检查 TLS 续期并安全重载 Nginx。

`ALERT_WEBHOOK_URL` 为空时只写 systemd 日志，不向任何外部平台发消息。填写后只发送任务级故障摘要，不发送文章正文或凭据。

## 9. 故障处理

```bash
docker compose --env-file .env.production -f docker-compose.production.yml ps
docker compose --env-file .env.production -f docker-compose.production.yml logs --tail=200 api worker nginx
./deploy/scripts/healthcheck.sh
```

- 出口 IP 不匹配：停止真实公众号草稿任务，检查 EIP/NAT 路由，更新微信白名单前不要绕过门禁。
- 证书失败：检查 A/AAAA 解析、安全组 80/443 和系统时间；不要临时关闭 HTTPS 公开登录页。
- 新版本失败：执行镜像回滚；若迁移导致数据不兼容，先隔离现场再从最近加密备份恢复。
- 磁盘超过 85%：健康检查失败；优先清理旧镜像和已过保留期备份，不删除数据库卷。
- 渠道异常：切回对应 `mock` 或 `off`，保持草稿箱与其他渠道可用，不盲目重复提交不确定状态的任务。

## 10. 安全边界

- 只有 Nginx 映射宿主机 80/443；数据库与内部服务只存在于 Docker 网络。
- API、Worker、Web、图片服务和 Nginx 使用只读根文件系统、去除 Linux capabilities、`no-new-privileges` 和资源限制。
- Docker 日志按 10 MiB × 5 轮转；应用日志已脱敏认证头、Cookie 和密码。
- `.env.production`、证书状态、发布状态和备份均被 Git 忽略。
- 小红书和 LinkedIn 仍为禁用占位能力。
- 该工程没有改动 WorkBuddy 的任何 Skill、Connector 或本地配置。
