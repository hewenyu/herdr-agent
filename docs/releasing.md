# v0.3.x 与 npm 分发

重构首版计划为 `v0.3.0`，后续按 SemVer 发布。npm 包名为 `@yuebanlaosiji/myrix`，薄启动器提供 `myrix` 和兼容命令 `herdr-agent`；状态目录仍使用 `~/.herdr-agent`。根 package.json 是私有源码包，不直接发布。

## 发布条件与顺序

1. 修复本轮已确认问题，完成相关真实飞书验收及资源清理，记录未覆盖项。
2. 最终源码通过 format、lint、typecheck、测试、1000 行限制及三平台 CI；合并 PR 后从实际主分支提交创建新的 `v0.3.x` tag。
3. tag 自动触发三平台原生 SEA 构建和独立烟测。打包包含完整 LICENSES，禁止用一个平台的二进制伪装其他平台。
4. 从原始构建产物生成 npm 包，验证架构、执行位、版本、提交及离线全局安装。平台包先发布，主包最后发布；主包精确依赖同版本平台包。
5. npm publish 步骤在写入前逐包核对已存在版本的 integrity；已存在且 integrity 相同的不可变版本会跳过，主包仍最后发布。npm 接受发布后可能需要几分钟才在公共 registry 暴露 metadata，Release workflow 不等待这段传播。
6. npm 分发离线安装验证通过后创建 GitHub Release，上传三个原生压缩包与 SHA256SUMS。Release workflow 不执行公共 registry 下载验收。

GitHub environment 名为 `NPM`，secret 名为 `TOKEN`。仅 npm publish 步骤注入 NODE_AUTH_TOKEN。TOKEN 必须对 `@yuebanlaosiji` scope 具有写权限。稳定版发布到 `latest`，预发布版到 `next`。默认三个平台包为 `@yuebanlaosiji/myrix-darwin-arm64`、`@yuebanlaosiji/myrix-linux-arm64`、`@yuebanlaosiji/myrix-linux-x64`。

## 安装与核对

```sh
npm install -g @yuebanlaosiji/myrix
myrix version --json
myrix help
```

npm 启动器要求 Node >=18，不能关闭 optional dependencies。独立压缩包内二进制已经包含 Node，无需安装 Node；仍需要 herdr、已登录的 Claude/Codex 和兼容的系统库。安装不执行 postinstall 下载或构建。

## 失败恢复

部分 npm 发布失败时，在同一次 Actions 运行中仅重跑失败的 npm-publish 及下游任务，复用成功 build 的原始产物。脚本先核对全部已存在版本的 integrity：相同内容才跳过，任何不一致都在继续发布前拒绝。主包最后发布，避免正常安装提前引用未发布平台包。

不能移动公开 tag、覆盖或撤销已发布版本来制造通过。原产物过期或完整性不符时，先核对并恢复原产物；不能用重建的不同字节强行续发。源码或工作流需要修改时，按正常 PR 修复并发布新的 v0.3.x 版本。npm 成功但 GitHub Release 失败时，保留已发布版本，仅重跑尚未成功的步骤。

发布成功必须有 Actions 与实际 registry 安装证据；本地 pack 成功不等于已发布。
