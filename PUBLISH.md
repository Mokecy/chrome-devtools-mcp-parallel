# Publishing to npm

## 一次性准备

### 1. GitHub 仓库

已指向 `https://github.com/Mokecy/chrome-devtools-mcp-parallel`（见 `package.json#repository`）。
首次推代码：

```powershell
git remote add origin https://github.com/Mokecy/chrome-devtools-mcp-parallel.git
git push -u origin main
```

### 2. npm Access Token

在 [https://www.npmjs.com/settings/tokens](https://www.npmjs.com/settings/tokens) 新建 **Automation** 或 **Granular Access** token（write 权限）。

在 GitHub 仓库 Settings → Secrets and variables → Actions → New repository secret：

- Name: `NPM_TOKEN`
- Value: 上面生成的 token

### 3. npm 包名占位（可选）

第一次发布前手动 `npm publish --access public` 一次，或直接让 CI 发首版（只要包名未被占用）。

## 日常发布

**方式一：脚本（推荐）**

```powershell
# patch: 0.25.0 -> 0.25.1
release.bat patch

# minor: 0.25.0 -> 0.26.0
release.bat minor

# major: 0.25.0 -> 1.0.0
release.bat major
```

脚本做：

1. 校验工作树干净
2. `npm version <type> --no-git-tag-version`
3. `git commit -m "release: vX.Y.Z"`
4. `git tag -a vX.Y.Z -m "..."`
5. `git push && git push --tags`

推 tag 后 `.github/workflows/publish.yml` 自动触发：

- `npm ci`
- `npm run bundle`（tsc + rollup，产 `build/src/**/*.js` + `build/src/third_party/*` 全 bundle）
- `npm publish --provenance --access public`

**方式二：手动**

```powershell
npm version patch
git push && git push --tags
```

**方式三：手动触发（调试）**

GitHub Actions → Publish to npm → Run workflow（走当前 `package.json#version`，若版本已存在会失败）。

## 使用发布后的包

```json
{
  "mcpServers": {
    "chrome-devtools-mcp": {
      "command": "npx",
      "args": [
        "chrome-devtools-mcp-parallel@latest",
        "--headless",
        "--max-instances",
        "5"
      ]
    }
  }
}
```

bin 入口：`chrome-devtools-mcp-parallel`（及 `chrome-devtools-mcp` / `chrome-devtools` 两个上游原名，便于 drop-in 替换）。

## 常见问题

- **npm 403**: `NPM_TOKEN` 没设或过期，或包名已被他人占用。
- **provenance 403**: 当前包首次发布必须用 `npm publish --provenance --access public`，workflow 已带 `id-token: write`，直接跑即可。
- **bundle 失败**: 本地 `npm run bundle` 先通了再发，主要依赖 `chrome-devtools-frontend` 的 `prepare` 脚本清冲突类型声明。
- **CI 里 npm ci 失败**: `package-lock.json` 需与 `package.json` 同步，先本地跑 `npm install` 后再提交。
