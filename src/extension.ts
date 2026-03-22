import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_MB, StagingEntry, StagingManager } from './StagingManager';
import { TransferBridge } from './TransferBridge';
import { StagingViewItem, StagingViewProvider } from './StagingViewProvider';

const CMD_STAGE = 'remoteFileTransfer.stageFiles';
const CMD_FETCH = 'remoteFileTransfer.fetchFiles';
const CMD_DELETE = 'remoteFileTransfer.deleteStagedFiles';
const CMD_DELETE_ONE = 'remoteFileTransfer.deleteSingleStagedFile';
const CMD_REFRESH_VIEW = 'remoteFileTransfer.refreshStagingView';
const SESSION_HEARTBEAT_INTERVAL_MS = 20_000;

interface EntryQuickPickItem extends vscode.QuickPickItem {
  entry: StagingEntry;
}

let deactivateState:
  | {
      stagingManager: StagingManager;
      sessionId: string;
      heartbeatTimer: NodeJS.Timeout;
    }
  | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const stagingManager = new StagingManager();
  const transferBridge = new TransferBridge(stagingManager);
  const stagingViewProvider = new StagingViewProvider(stagingManager);
  const stagingTreeView = vscode.window.createTreeView('remoteFileTransfer.stagingView', {
    treeDataProvider: stagingViewProvider,
    canSelectMany: true
  });

  void stagingManager.cleanupExpiredAndOrphans().catch((error) => {
    console.error('[remote-file-transfer] cleanup on activate failed', error);
  });
  stagingViewProvider.refresh();

  const sessionId = randomUUID();
  void stagingManager.registerSession(sessionId).catch((error) => {
    console.error('[remote-file-transfer] session register failed', error);
  });
  const heartbeatTimer = setInterval(() => {
    void stagingManager.touchSession(sessionId).catch((error) => {
      console.error('[remote-file-transfer] session heartbeat failed', error);
    });
  }, SESSION_HEARTBEAT_INTERVAL_MS);
  deactivateState = { stagingManager, sessionId, heartbeatTimer };

  const stageDisposable = vscode.commands.registerCommand(
    CMD_STAGE,
    async (clickedUri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
      await handleStageCommand(transferBridge, stagingViewProvider, clickedUri, selectedUris);
    }
  );

  const fetchDisposable = vscode.commands.registerCommand(CMD_FETCH, async (targetFolderUri?: vscode.Uri) => {
    await handleFetchCommand(stagingManager, transferBridge, targetFolderUri);
  });

  const deleteDisposable = vscode.commands.registerCommand(CMD_DELETE, async () => {
    await handleDeleteCommand(stagingManager, stagingViewProvider);
  });

  const deleteOneDisposable = vscode.commands.registerCommand(
    CMD_DELETE_ONE,
    async (item?: StagingViewItem, selectedItems?: StagingViewItem[]) => {
      const targets = collectViewSelection(item, selectedItems, stagingTreeView.selection);
      await handleDeleteFromViewCommand(stagingManager, stagingViewProvider, targets);
    }
  );

  const refreshViewDisposable = vscode.commands.registerCommand(CMD_REFRESH_VIEW, () => {
    stagingViewProvider.refresh();
  });

  context.subscriptions.push(
    stageDisposable,
    fetchDisposable,
    deleteDisposable,
    deleteOneDisposable,
    refreshViewDisposable,
    stagingTreeView,
    new vscode.Disposable(() => clearInterval(heartbeatTimer))
  );
}

async function handleStageCommand(
  transferBridge: TransferBridge,
  stagingViewProvider: StagingViewProvider,
  clickedUri?: vscode.Uri,
  selectedUris?: vscode.Uri[]
): Promise<void> {
  const uris = normalizeUris(clickedUri, selectedUris);
  if (uris.length === 0) {
    vscode.window.showInformationMessage('未找到可暂存的文件。');
    return;
  }

  let success = 0;
  let skippedDirectories = 0;
  let skippedSymlinks = 0;
  let skippedUnsupported = 0;
  let skippedOversize = 0;
  let failed = 0;

  for (const uri of uris) {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const isDirectory = (stat.type & vscode.FileType.Directory) !== 0;
      const isSymlink = (stat.type & vscode.FileType.SymbolicLink) !== 0;
      const isFile = (stat.type & vscode.FileType.File) !== 0;

      if (isDirectory) {
        skippedDirectories += 1;
        continue;
      }

      if (isSymlink) {
        skippedSymlinks += 1;
        continue;
      }

      if (!isFile) {
        skippedUnsupported += 1;
        continue;
      }

      if (stat.size > MAX_FILE_SIZE_BYTES) {
        skippedOversize += 1;
        continue;
      }

      await transferBridge.stageRemoteFile(uri);
      success += 1;
    } catch (error) {
      failed += 1;
      console.error('[remote-file-transfer] stage failed', uri.toString(), error);
    }
  }

  const segments: string[] = [];
  segments.push(`成功暂存 ${success} 个文件。`);

  if (skippedDirectories > 0) {
    segments.push(`已跳过 ${skippedDirectories} 个目录。`);
  }
  if (skippedSymlinks > 0) {
    segments.push(`已跳过 ${skippedSymlinks} 个软链。`);
  }
  if (skippedUnsupported > 0) {
    segments.push(`已跳过 ${skippedUnsupported} 个非文件资源。`);
  }
  if (skippedOversize > 0) {
    segments.push(`已跳过 ${skippedOversize} 个超过 ${MAX_FILE_SIZE_MB}MB 的文件。`);
  }
  if (failed > 0) {
    segments.push(`失败 ${failed} 个。`);
  }

  vscode.window.showInformationMessage(segments.join(' '));
  if (success > 0) {
    stagingViewProvider.refresh();
  }
}

async function handleFetchCommand(
  stagingManager: StagingManager,
  transferBridge: TransferBridge,
  targetFolderUri?: vscode.Uri
): Promise<void> {
  if (!targetFolderUri) {
    vscode.window.showWarningMessage('请在资源管理器中右键目标目录后再执行拉取。');
    return;
  }

  try {
    const folderStat = await vscode.workspace.fs.stat(targetFolderUri);
    const isFolder = (folderStat.type & vscode.FileType.Directory) !== 0;
    if (!isFolder) {
      vscode.window.showWarningMessage('拉取目标必须是目录。');
      return;
    }
  } catch (error) {
    vscode.window.showErrorMessage(`无法访问目标目录: ${(error as Error).message}`);
    return;
  }

  let entries: StagingEntry[] = [];
  try {
    entries = await stagingManager.listEntries();
  } catch (error) {
    vscode.window.showErrorMessage(`读取全局池失败: ${(error as Error).message}`);
    return;
  }

  if (entries.length === 0) {
    vscode.window.showInformationMessage('全局池为空。');
    return;
  }

  const items: EntryQuickPickItem[] = entries.map((entry) => ({
    label: entry.filename,
    description: buildWorkspaceDescription(entry),
    detail: buildEntryDetail(entry),
    entry
  }));

  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: '选择要拉取的文件',
    matchOnDescription: true,
    matchOnDetail: true,
    title: '📥 从全局池拉取...'
  });

  if (!picked || picked.length === 0) {
    return;
  }

  try {
    const summary = await transferBridge.fetchEntriesToFolder(
      targetFolderUri,
      picked.map((item) => item.entry)
    );

    vscode.window.showInformationMessage(
      `拉取完成：成功 ${summary.success}，覆盖 ${summary.overwritten}，自动重命名 ${summary.renamed}，跳过 ${summary.skipped}，失败 ${summary.failed}。`
    );
  } catch (error) {
    vscode.window.showErrorMessage(`拉取失败: ${(error as Error).message}`);
  }
}

async function handleDeleteCommand(
  stagingManager: StagingManager,
  stagingViewProvider: StagingViewProvider
): Promise<void> {
  let entries: StagingEntry[] = [];
  try {
    entries = await stagingManager.listEntries();
  } catch (error) {
    vscode.window.showErrorMessage(`读取全局池失败: ${(error as Error).message}`);
    return;
  }

  if (entries.length === 0) {
    vscode.window.showInformationMessage('全局池为空，无需删除。');
    return;
  }

  const action = await vscode.window.showQuickPick(
    [
      {
        label: '删除选中的暂存文件...',
        value: 'partial'
      },
      {
        label: '删除全部暂存文件',
        value: 'all'
      }
    ],
    {
      placeHolder: '选择删除方式',
      title: '🗑️ 删除全局池文件'
    }
  );

  if (!action) {
    return;
  }

  if (action.value === 'all') {
    const confirm = await vscode.window.showWarningMessage(
      `确定删除全局池中的全部 ${entries.length} 个文件吗？`,
      { modal: true },
      '删除全部'
    );

    if (confirm !== '删除全部') {
      return;
    }

    try {
      const deletedCount = await stagingManager.clearAllEntries();
      vscode.window.showInformationMessage(`已删除 ${deletedCount} 个暂存文件。`);
      stagingViewProvider.refresh();
    } catch (error) {
      vscode.window.showErrorMessage(`删除全部失败: ${(error as Error).message}`);
    }
    return;
  }

  const items: EntryQuickPickItem[] = entries.map((entry) => ({
    label: entry.filename,
    description: buildWorkspaceDescription(entry),
    detail: buildEntryDetail(entry),
    entry
  }));

  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: '选择要删除的暂存文件',
    matchOnDescription: true,
    matchOnDetail: true,
    title: '🗑️ 删除选中的暂存文件'
  });

  if (!picked || picked.length === 0) {
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `确定删除选中的 ${picked.length} 个暂存文件吗？`,
    { modal: true },
    '删除'
  );

  if (confirm !== '删除') {
    return;
  }

  try {
    const result = await stagingManager.deleteEntriesByIds(picked.map((item) => item.entry.id));
    vscode.window.showInformationMessage(
      `删除完成：已删除 ${result.deleted}，未找到 ${result.notFound}。`
    );
    stagingViewProvider.refresh();
  } catch (error) {
    vscode.window.showErrorMessage(`删除失败: ${(error as Error).message}`);
  }
}

function normalizeUris(clickedUri?: vscode.Uri, selectedUris?: vscode.Uri[]): vscode.Uri[] {
  const values = Array.isArray(selectedUris) && selectedUris.length > 0
    ? selectedUris
    : clickedUri
      ? [clickedUri]
      : [];

  const dedup = new Map<string, vscode.Uri>();
  for (const uri of values) {
    dedup.set(uri.toString(), uri);
  }

  return [...dedup.values()];
}

function buildWorkspaceDescription(entry: StagingEntry): string {
  const segments = [entry.workspaceName];
  if (entry.remoteHost) {
    segments.push(`Host: ${entry.remoteHost}`);
  }
  if (entry.dockerContainer) {
    segments.push(`Docker: ${entry.dockerContainer}`);
  }
  return segments.join(' | ');
}

function buildEntryDetail(entry: StagingEntry): string {
  const base = `${entry.remoteAuthority}${entry.path}`;
  const segments = [base];
  if (entry.remoteHost) {
    segments.push(`主机: ${entry.remoteHost}`);
  }
  if (entry.dockerContainer) {
    segments.push(`容器: ${entry.dockerContainer}`);
  }
  return segments.join(' | ');
}

async function handleDeleteFromViewCommand(
  stagingManager: StagingManager,
  stagingViewProvider: StagingViewProvider,
  items: StagingViewItem[]
): Promise<void> {
  const validItems = items.filter((item) => !item.entry.id.startsWith('__placeholder_'));
  if (validItems.length === 0) {
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `确定删除选中的 ${validItems.length} 个暂存文件吗？`,
    { modal: true },
    '删除'
  );
  if (confirm !== '删除') {
    return;
  }

  try {
    const result = await stagingManager.deleteEntriesByIds(validItems.map((item) => item.entry.id));
    vscode.window.showInformationMessage(`删除完成：已删除 ${result.deleted}，未找到 ${result.notFound}。`);
    stagingViewProvider.refresh();
  } catch (error) {
    vscode.window.showErrorMessage(`删除失败: ${(error as Error).message}`);
  }
}

function collectViewSelection(
  clickedItem: StagingViewItem | undefined,
  selectedItems: StagingViewItem[] | undefined,
  treeSelection: readonly StagingViewItem[]
): StagingViewItem[] {
  if (Array.isArray(selectedItems) && selectedItems.length > 0) {
    return selectedItems;
  }

  if (clickedItem) {
    return [clickedItem];
  }

  if (treeSelection.length > 0) {
    return [...treeSelection];
  }

  return [];
}

export async function deactivate(): Promise<void> {
  if (!deactivateState) {
    return;
  }

  const { stagingManager, sessionId, heartbeatTimer } = deactivateState;
  deactivateState = undefined;
  clearInterval(heartbeatTimer);

  try {
    await stagingManager.unregisterSessionAndCleanupIfLast(sessionId);
  } catch (error) {
    console.error('[remote-file-transfer] deactivate cleanup failed', error);
  }
}
