# 渠道 Skill 模板同步

网站运行时不依赖员工电脑上的 `SKILL.md`。官网和公众号 Skill 会在发布代码前生成版本化快照，随 Worker 一起部署。

首次同步：

```bash
pnpm skills:sync
```

当官网 Skill 更新时：

```bash
pnpm skills:sync -- --website-version 1.1.0
```

当公众号 Skill 更新时：

```bash
pnpm skills:sync -- --wechat-version 1.1.0
```

两个 Skill 同时更新：

```bash
pnpm skills:sync -- --website-version 1.1.0 --wechat-version 1.1.0
```

同步脚本读取：

- `~/.codex/skills/gd-market-guanwang-auto`
- `~/.codex/skills/gd-market-gzh-auto`

规则内容发生变化但未明确提升版本时，脚本会拒绝覆盖。生成的快照、版本号和 SHA-256 摘要需要一并提交到 Git。每个内容任务会保存实际使用的 Skill 名称、版本和摘要，历史任务不会被后续模板更新改写。

## 服务器更新模板

Skill 在本机同步并提交代码后，服务器只需拉取新版本并重新部署：

```bash
git pull
pnpm prod:deploy
```

服务器不需要安装 WorkBuddy Skill，模板快照已经包含在 Worker 镜像中。
