# dsh-harnessmm 安装手册

在 DeepSeek Harness 中安装「HarnessMM 节省」插件：一个能读懂动作库的 `terminal`
工具——慢思考轮次编排好的确定性后继命令不再付推理调用，每次替换都签发可审计的证书；
应用内底部状态栏与「HarnessMM 节省」面板实时展示省掉的调用与估算节省。

- **兼容性**：DeepSeek Harness **0.2.1-rc.2**（其他 0.2.x 版本通常兼容）；Node
  ≥ 22.13 或 ≥ 24（仅使用内置模块）
- **零依赖零构建**：插件不依赖任何 npm 包，离线可装
- **数据本地**：账本只保存在 profile 进程内存里，不写磁盘、不上传
- **策略版本**：默认 v6（确定性准入）；v7/v8/v10 需要改 bundle 配置，其中
  v8/v10 还需要冻结的 TRAIN 先验表，缺先验时失败关闭

## 你手上的三种交付物

| 形式 | 用途 |
|---|---|
| `dsh-harnessmm.tgz` | 标准 npm 打包，Plugin Manager「添加插件」直接粘贴路径安装（从 [Releases](https://github.com/15217814598/dsh-harnessmm/releases) 下载） |
| `dsh-harnessmm.zip` | 解压后得到插件目录，适合走本地目录安装 |
| 本仓库源码（git clone 后） | 开发 / 二次修改；仓库根目录即插件目录 |

## 方式一：Plugin Manager 界面安装（推荐）

1. 打开 Harness：**设置 → 插件**（Plugins）页面；
2. 点击 **添加插件**（Add plugin）；
3. 在包名/地址框中粘贴 **tgz 的绝对路径**（如 `E:\dist\dsh-harnessmm.tgz`），
   或解压 zip 后粘贴**插件目录的绝对路径**（如 `E:\dist\dsh-harnessmm`），
   也可以直接粘贴 GitHub 仓库地址 `15217814598/dsh-harnessmm`（需联网）；
4. 确认信任提示后点击 **安装**；
5. 安装完成后在插件列表中确认出现 **dsh-harnessmm-plugin** 且已启用。

## 方式二：让 DSH 代理安装（会话内执行）

在任意具备权限的 Harness 会话中，让代理调用 `plugin_manager` 工具：

- `action: install_bundle`
- `target:` tgz 或插件目录的**绝对路径**

bundle patch 会插入一行 `harnessmm` 配置（policy v6 默认值）。本插件没有任何
构建脚本，不会出现构建确认提示。

## 方式三：手动安装（高级用户）

适用于界面与代理都不可用的场景，等效于 `install_bundle`：

1. 把插件目录放进 profile（或在 profile 的 `package.json` 里以
   `link:`/`file:` 依赖引入）并 `pnpm install`；
2. 把 `dsh-harnessmm-plugin` 加进 profile `package.json` 的
   `dsh.profile.bundles` 列表；
3. 重启宿主。bundle 自带的 `cordis.patch.yml` 会作为一层补丁自动生效。

## 安装后验证

1. 重启宿主后，启动日志应出现：
   `[dsh-harnessmm] mounted terminal (policy v6, priors off, selector on, shell auto)`；
2. 底部状态栏出现 **HarnessMM** 条目（省掉的调用数与估算节省）；
3. 会话里执行 `/harnessmm` 查看计数；跑一条确定性的命令链（如
   build → test → smoke），面板与账本会逐张冒出证书。

## 注意

- **链接安装（`link:`）时改了插件源码，需要重启宿主**才会加载新的模块代；
  `./client` 导出路径即浏览器模块身份，热替换可另存 `client.v2.js` 并更新导出。
- 卸载：Plugin Manager 移除插件即可；`/harnessmm clear` 或面板上的
  「清空本会话」只清账本，不影响插件。
