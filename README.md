# vscode-remote-file-transfer

在严格内网隔离环境下，通过 VS Code 内置 RPC（`vscode.workspace.fs`）+ 本地临时目录桥接，实现两个相互隔离的 Remote-SSH 窗口之间的中小型文件传输。

## 设计目标

- 不使用 WebSocket、本地端口、任何自定义网络协议。
- 插件强制运行在 UI 侧（本地机器），共享本地硬盘作为暂存池。
- 仅支持单文件传输（MVP），不处理目录递归。

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
  workspaceName: string,
  path: string,
  timestamp: number
}
```

### 覆盖策略

只有当 `remoteAuthority` 和 `path` 同时完全相同，才会覆盖旧记录；同名但来源不同的文件可并存。

## 功能说明

### 1) 暂存文件（📤 暂存到全局池）

- 入口：资源管理器右键文件。
- 支持多选。
- 自动过滤目录/软链。
- 文件大小上限：`50MB`（`MAX_FILE_SIZE_MB`）。
- 读取远端文件：`vscode.workspace.fs.readFile`（`Uint8Array`）。
- 写入本地缓存：按二进制写入 UUID 文件，不做文本编码转换。
- 完成后显示汇总提示（成功/跳过/失败）。

### 2) 拉取文件（📥 从全局池拉取...）

- 入口：资源管理器右键目标目录。
- 使用 `QuickPick(canPickMany)` 选择待拉取项。
  - `label = filename`
  - `description = workspaceName`
  - `detail = remoteAuthority + path`
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

### Docker 容器标识

- 当文件来自 `attached-container` 或 `dev-container` 类型远程环境时，会在暂存记录中写入 `dockerContainer` 字段。
- 在拉取和删除的 QuickPick 列表中会显示容器标识，便于区分来源容器。

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

- 当前为 MVP，仅处理单文件。
- 大文件（>50MB）会被拦截。
- 建议后续增加 `.vscodeignore` 或 `package.json.files` 以缩小 VSIX 体积。

## License

MIT
