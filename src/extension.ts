import * as vscode from 'vscode';
import { MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_MB, StagingEntry, StagingManager } from './StagingManager';
import { TransferBridge } from './TransferBridge';

const CMD_STAGE = 'remoteFileTransfer.stageFiles';
const CMD_FETCH = 'remoteFileTransfer.fetchFiles';

interface EntryQuickPickItem extends vscode.QuickPickItem {
  entry: StagingEntry;
}

export function activate(context: vscode.ExtensionContext): void {
  const stagingManager = new StagingManager();
  const transferBridge = new TransferBridge(stagingManager);

  void stagingManager.cleanupExpiredAndOrphans().catch((error) => {
    console.error('[remote-file-transfer] cleanup on activate failed', error);
  });

  const stageDisposable = vscode.commands.registerCommand(
    CMD_STAGE,
    async (clickedUri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
      await handleStageCommand(transferBridge, clickedUri, selectedUris);
    }
  );

  const fetchDisposable = vscode.commands.registerCommand(CMD_FETCH, async (targetFolderUri?: vscode.Uri) => {
    await handleFetchCommand(stagingManager, transferBridge, targetFolderUri);
  });

  context.subscriptions.push(stageDisposable, fetchDisposable);
}

async function handleStageCommand(
  transferBridge: TransferBridge,
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
    description: entry.workspaceName,
    detail: `${entry.remoteAuthority}${entry.path}`,
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

export function deactivate(): void {
  // no-op
}
