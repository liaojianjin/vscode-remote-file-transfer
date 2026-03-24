# vscode-remote-file-transfer

在严格内网隔离环境下，通过 VS Code 内置 RPC（`vscode.workspace.fs`）+ 本地临时目录桥接，实现两个相互隔离的 Remote-SSH 窗口之间的中小型文件传输。

## 设计目标

- 不使用 WebSocket、本地端口、任何自定义网络协议。
- 插件强制运行在 UI 侧（本地机器），共享本地硬盘作为暂存池。
- 支持单文件与目录（递归）传输。

## 核心架构

- `extensionKind: ["ui"]`
- 本地暂存目录：`os.tmpdir()/vscode-remote-file-transfer`
- 数据索引：`staging.json`
- 物理文件命名：UUID v4（避免文件名冲突）

### 暂存记录结构

```ts
{
  id: string,
  filename: string,
  size: number,
  remoteAuthority: string,
  remoteHost?: string,
  workspaceName: string,
  path: string,
  dockerContainer?: string,
  dockerContainerId?: string,
  batchId?: string,
  rootFolderName?: string,
  relativePath?: string,
  timestamp: number
}
```

### 覆盖策略

只有当 `remoteAuthority` 和 `path` 同时完全相同，才会覆盖旧记录；同名但来源不同的文件可并存。

## 功能说明

### 1) 暂存文件（📤 暂存到全局池）

- 入口：资源管理器右键文件或目录。
- 支持从 Explorer 直接拖拽文件/目录到 `Global Staging Pool` 视图进行暂存。
- 支持多选。
- 目录会递归扫描并暂存目录内文件，自动保留相对路径。
- 自动过滤软链。
- 文件大小上限：可通过 `remoteFileTransfer.maxTransferFileSizeMB` 配置（默认 `50MB`）。
- 读取远端文件：`vscode.workspace.fs.readFile`（`Uint8Array`）。
- 写入本地缓存：按二进制写入 UUID 文件，不做文本编码转换。
- 完成后显示汇总提示（成功/跳过/失败）。

### 2) 拉取文件（📥 从全局池拉取...）

- 入口：资源管理器右键目标目录。
- 使用 `QuickPick(canPickMany)` 选择待拉取项。
  - 文件项按单文件展示
  - 目录项会聚合为一个可选批次（显示文件数量）
- 目录拉取会自动重建原始目录结构。
- 冲突处理：`覆盖 / 跳过 / 自动重命名`
- 写入目标：`vscode.workspace.fs.writeFile`
- 使用 `withProgress` 展示进度。
- 拉取后保留缓存记录（不删除 `staging.json` 条目）。

### 3) 删除暂存文件（🗑️ 删除全局池文件...）

- 支持两种模式：
  - 删除选中项（可多选）
  - 清空全部暂存文件
- 删除时会同时移除：
  - `staging.json` 记录
  - 本地 UUID 物理缓存文件

### 4) 暂存池专属视图（Explorer）

- 在 Explorer 中提供 `Global Staging Pool` 专属 View，实时展示全部暂存文件。
- 对目录暂存批次会以目录树形式展示（可展开子目录和文件）。
- 视图标题支持：
  - 刷新
  - 删除全局池文件
- 视图条目支持右键删除文件或目录（目录会删除其下全部暂存文件）。

### 5) 可配置最大传输文件大小

- 配置项：`remoteFileTransfer.maxTransferFileSizeMB`
- 类型：`number`
- 默认值：`50`
- 作用范围：单个文件“暂存到全局池”时的大小上限检查（包括右键暂存与拖拽暂存）。

### Docker 容器标识

- 当文件来自 `attached-container` 或 `dev-container` 类型远程环境时，会在暂存记录中写入 `dockerContainer` 字段。
- 解析逻辑会优先尝试本地 `docker inspect` / `docker ps` 获取容器友好名。
- 在拉取和删除的 QuickPick 列表中会显示 `Host + Docker` 来源信息，便于区分来源主机与容器。
- `Host` 会在暂存时优先尝试执行 `hostname`（本地窗口直接执行本机 `hostname`，SSH 场景走 `ssh <host> hostname`，容器场景走 `docker exec <container> hostname`），失败后回退读取 `/etc/hostname` 与 `/proc/sys/kernel/hostname`。
- 若仍无法得到主机名，界面不会显示 `Host` 字段（不展示 `Unknown`）。

## 并发与可靠性

- 排他锁：通过创建 `.lock` 目录实现。
- 死锁接管：基于 `mtime` 超时判定，使用 `fs.rmSync(lockPath, { recursive: true, force: true })` 回收。
- JSON 原子写：
  1. `fs.openSync(tmpPath, 'w')`
  2. `fs.writeSync(fd, stringData, null, 'utf-8')`
  3. `fs.fsyncSync(fd)`
  4. `fs.closeSync(fd)`
  5. `fs.renameSync(tmpPath, realPath)`
- TTL 清理：默认 `24h`，同时清理未被 `staging.json` 引用的孤儿物理文件。
- 会话生命周期清理：
  - 每个 VS Code 窗口会在本地注册会话并心跳续期。
  - 当“第一个窗口”打开（此前无活动会话）时，会先清空历史暂存池，避免跨会话残留。
  - 当最后一个 VS Code 窗口关闭（无活动会话）时，自动清空全部暂存文件。

## 项目结构

```text
src/
  extension.ts
  StagingManager.ts
  TransferBridge.ts
  test/
    StagingManager.test.ts
```

## 开发

```bash
npm install
npm run compile
npm test
```

## 打包

```bash
npm run package
```

产物示例：

- `vscode-remote-file-transfer-0.0.1.vsix`

## 注意事项

- 超过 `remoteFileTransfer.maxTransferFileSizeMB` 的文件会被拦截。
- 建议后续增加 `.vscodeignore` 或 `package.json.files` 以缩小 VSIX 体积。

## License

MIT
