# v0.3.x 与 npm 分发

重构首版计划为 `v0.3.0`，后续按 SemVer 发布。npm 包名为 `@yuebanlaosiji/myrix`，薄启动器提供 `myrix` 和兼容命令 `herdr-agent`；状态目录仍使用 `~/.herdr-agent`。根 package.json 是私有源码包，不直接发布。

## 发布条件与顺序

1. 修复本轮已确认问题，完成相关真实飞书验收及资源清理，记录未覆盖项。
2. 最终源码通过 format、lint、typecheck、测试、1000 行限制及三平台 CI；合并 PR 后从实际主分支提交创建新的 `v0.3.x` tag。
3. tag 自动触发三平台原生 SEA 构建和独立烟测。打包包含完整 LICENSES，禁止用一个平台的二进制伪装其他平台。
4. 从原始构建产物生成 npm 包，验证架构、执行位、版本、提交及离线全局安装。平台包先发布，主包最后发布；主包精确依赖同版本平台包。
5. npm publish 步骤在写入前逐包核对已存在版本的 integrity；已存在且 integrity 相同的不可变版本会跳过，主包仍最后发布。npm 接受发布后可能需要几分钟才在公共 registry 暴露 metadata，Release workflow 不等待这段传播。
6. npm 发布完成后创建或补全 GitHub Release，上传三个原生压缩包与 SHA256SUMS。新 Release 先创建为草稿，全部资产核验通过后再公开发布；同 tag 的已有草稿也按此顺序完成发布。已有 Release 保留正文、标题及预发布设置；脚本先核对全部同名资产的大小与 SHA-256，相同则跳过，冲突立即停止，仅补传缺失文件。Release workflow 不执行公共 registry 下载验收。

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

### 已有空 Release 或部分资产的补传

旧工作流使用 `gh release create`，如果先在网页创建了同名 Release，最后一步会报 `a release with the same tag name already exists`。重跑旧 run 仍使用原提交的工作流，合并本修复不会改变该 run 的代码。保留原 tag、npm 版本及 Release；不要为了重跑删除 Release 或移动 tag。

维护者可以从已通过构建和 npm 发布的原 run 下载三个 `binary-*` artifact（保留 7 天），再用已审核修复中的脚本补传。需要 Node >=24.13 和已认证的 `gh`（仓库 contents 写权限）。脚本不执行构建或 npm 发布，不需要安装项目依赖。

以下示例对应 `v0.3.14`；其他版本必须使用其原 run、tag 和完整提交 SHA。在包含修复脚本的 checkout 中操作，`release-original` 应为新目录：

```sh
mkdir release-original
gh run download 36145764578 --repo hewenyu/herdr-agent --name binary-darwin_arm64 --dir release-original
gh run download 36145764578 --repo hewenyu/herdr-agent --name binary-linux_arm64 --dir release-original
gh run download 36145764578 --repo hewenyu/herdr-agent --name binary-linux_amd64 --dir release-original
```

从原压缩包生成校验清单（不解包重建）；macOS 将 `sha256sum` 换为 `shasum -a 256`：

```sh
(cd release-original && sha256sum herdr-agent_v0.3.14_*.tar.gz > SHA256SUMS)
node --experimental-strip-types scripts/release-assets.ts hewenyu/herdr-agent v0.3.14 46cd870a0371c4be2d34685378e1e68bcd4666ec release-original
```

脚本核对远端 tag 的实际提交。已有公开 Release 的设置不会被编辑；不存在时仅在确认 HTTP 404 后创建草稿，可用第五个参数提供新 Release 的说明文件。已有草稿与新草稿都会在四个资产完整核验后公开发布，仅改变草稿状态，保留原说明等设置；上传失败则保留草稿以便重试。所有已有同名资产在首次上传前完成大小及摘要核对；API 无 SHA-256 时下载原资产计算，不把文件名相同当成一致。上传不使用 `--clobber`；结果未知时只重读核验，不盲目再次上传。部分补传中断后可对同一批原文件重跑，相同文件跳过。权限错误、内容冲突、未完成的 `starter` 资产或不可变 Release 缺件都会停止，需要维护者核查。

人工补传不会把旧失败 run 改成成功，应保留该记录及补传验收证据。
