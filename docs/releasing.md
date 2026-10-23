# npm 发布

包名为 `@wacry/codeks-bridge`。只发布编译后的 JavaScript、模型目录、调试 UI 和随包文档，运行时零依赖。版本使用普通 semver，tag 为 `v<版本号>`。

## 日常验证

GitHub Actions 工作流 `codeks-bridge-npm.yml` 只手动触发，不在每次提交时运行。默认 `publish=false`：安装开发依赖、类型检查、测试、构建、公开信息检查，再生成 npm tarball，并在 Node.js 24 和最低运行时 20.19 上安装验证公开 API、类型、CLI、嵌入请求与 UI 资源。工作流保存实际测试过的 tarball，发布步骤直接使用同一份文件。

```sh
gh workflow run codeks-bridge-npm.yml --ref main
```

## Trusted publisher

首次发布 `0.0.1` 使用本机临时 npm token 建立包。后续 GitHub Actions 只使用 OIDC，不保存 npm 发布 token。

首次发布后，在 npm 包的 Settings → Trusted Publisher 配置 GitHub Actions：

- Organization or user：`WAcry`
- Repository：`codeks-bridge`
- Workflow filename：`codeks-bridge-npm.yml`
- Environment name：留空
- 若页面提供权限选项，只授予 publish。

可在 npm 页面完成配置；允许 bypass 2FA 的发布 token 不能用于创建 trusted publisher。工作流使用 GitHub 托管 runner、Node.js 24 和 npm 11，发布时请求 OIDC 身份并生成 provenance。配置要求见 [npm trusted publishing 文档](https://docs.npmjs.com/trusted-publishers/)。

## 发布新版本

在开发分支修改版本，完成审查并合并到 `main`。`npm version` 同时更新 `package.json` 和 lockfile；已有版本不能覆盖。

```sh
npm version 0.0.2 --no-git-tag-version
```

合并后，在对应的 `main` 提交上创建并推送 tag，再手动发布：

```sh
git tag -a v0.0.2 -m 'Release 0.0.2'
git push origin v0.0.2
gh workflow run codeks-bridge-npm.yml --ref v0.0.2 -f publish=true
```

只有名称与 `package.json` 版本一致、提交已进入 `main` 的 tag 才能发布。验证或包安装测试失败时停止，不发布。

发布后核对 npm 的版本、tarball 和 CLI：

```sh
npm view @wacry/codeks-bridge version dist.tarball --registry=https://registry.npmjs.org
npx --yes --package @wacry/codeks-bridge@0.0.2 codeks-bridge --help
```
