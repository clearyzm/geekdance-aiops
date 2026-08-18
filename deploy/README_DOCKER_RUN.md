# Docker Run 启动说明

本说明不用 `docker compose`。当前运行形态是一个 `app` 容器，镜像内同时启动 `web + api + worker + image-worker`。PostgreSQL 和 Redis 连接宿主机已有服务。

## 镜像来源

应用镜像基于 docker.aityp.com 对应的 Node 官方同步镜像：

- `swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/node:22-bookworm-slim`
- 镜像页：https://docker.aityp.com/image/docker.io/library/node%3A22-bookworm-slim

`image-worker` 需要的 Python 运行时在构建 `app` 镜像时安装进同一个容器。

## 环境变量

复制并填写 `.env`：

```bash
cp .env.example .env
```

把 PostgreSQL 和 Redis 地址改为宿主机地址。Docker Desktop 可直接使用 `host.docker.internal`；Linux 使用下方 `docker run` 里的 `--add-host host.docker.internal:host-gateway`。

```dotenv
DATABASE_URL=postgresql://geekdance_ops:replace-with-password@host.docker.internal:55432/geekdance_ops
REDIS_URL=redis://host.docker.internal:6379
API_INTERNAL_URL=http://127.0.0.1:4000
IMAGE_SERVICE_URL=http://127.0.0.1:8000
APP_ORIGIN=http://localhost:3000
```

如果宿主机 Redis 设置了密码，使用 `redis://:password@host.docker.internal:6379`。

## 构建镜像

```bash
release="$(git rev-parse --short HEAD)"
docker build --target app \
  --build-arg APP_RELEASE="$release" \
  -t "geekdance-ai-ops/app:$release" .
```

`APP_RELEASE` 必须使用本次实际部署的提交 SHA（或流水线发布号）。生产环境不要继续使用默认的 `local`，否则健康接口无法证明当前运行的是哪次发布。

默认依赖源：

- npm / pnpm: `https://registry.npmmirror.com`
- apt: `http://mirrors.aliyun.com/debian`
- PyPI: `https://mirrors.aliyun.com/pypi/simple/`

如需使用内网源，可通过 `--build-arg NPM_REGISTRY=...`、`--build-arg APT_MIRROR=...`、`--build-arg PIP_INDEX_URL=...` 覆盖。

## 启动容器

创建应用数据卷：

```bash
docker volume create geekdance_assets
docker volume create geekdance_rembg
```

启动 `app`：

```bash
docker run -d \
  --name geekdance-app \
  --restart unless-stopped \
  --add-host host.docker.internal:host-gateway \
  --env-file .env \
  -e NODE_ENV=production \
  -e API_PORT=4000 \
  -e PORT=3000 \
  -e HOSTNAME=0.0.0.0 \
  -e API_INTERNAL_URL=http://127.0.0.1:4000 \
  -e IMAGE_SERVICE_URL=http://127.0.0.1:8000 \
  -v geekdance_assets:/data/assets \
  -v geekdance_rembg:/home/node/.u2net \
  -p 127.0.0.1:3000:3000 \
  -e APP_RELEASE="$release" \
  "geekdance-ai-ops/app:$release"
```

访问 `http://localhost:3000`。

## 检查和清理

```bash
docker logs -f --tail=200 geekdance-app
docker exec geekdance-app node -e "fetch('http://127.0.0.1:4000/health').then(r=>{if(!r.ok)process.exit(1)})"
docker exec geekdance-app python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health')"
```

停止容器：

```bash
docker rm -f geekdance-app
```

数据卷默认保留。确认不再需要数据后，再手动删除：

```bash
docker volume rm geekdance_assets geekdance_rembg
```
