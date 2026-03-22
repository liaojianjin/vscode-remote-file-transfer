import * as path from 'node:path';
import * as vscode from 'vscode';
import { StagingEntry, StagingManager } from './StagingManager';

export interface FetchSummary {
  success: number;
  skipped: number;
  overwritten: number;
  renamed: number;
  failed: number;
}

type ConflictAction = 'overwrite' | 'skip' | 'rename';

export class TransferBridge {
  constructor(private readonly stagingManager: StagingManager) {}

  public async stageRemoteFile(uri: vscode.Uri): Promise<StagingEntry> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const workspaceName = vscode.workspace.getWorkspaceFolder(uri)?.name || 'Unknown';
    const filename = path.posix.basename(uri.path) || path.basename(uri.fsPath) || 'unnamed';

    return this.stagingManager.stageBinaryFile(bytes, {
      filename,
      size: bytes.byteLength,
      remoteAuthority: uri.authority,
      workspaceName,
      path: uri.path
    });
  }

  public async fetchEntriesToFolder(
    targetFolderUri: vscode.Uri,
    entries: StagingEntry[]
  ): Promise<FetchSummary> {
    const total = entries.length;
    const summary: FetchSummary = {
      success: 0,
      skipped: 0,
      overwritten: 0,
      renamed: 0,
      failed: 0
    };

    if (total === 0) {
      return summary;
    }

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: '从全局池拉取文件',
        cancellable: false
      },
      async (progress) => {
        for (let i = 0; i < total; i += 1) {
          const entry = entries[i];
          progress.report({
            increment: 100 / total,
            message: `${entry.filename} (${i + 1}/${total})`
          });

          try {
            let targetUri = vscode.Uri.joinPath(targetFolderUri, entry.filename);
            const targetExists = await this.exists(targetUri);

            if (targetExists) {
              const action = await this.askConflictAction(entry.filename);
              if (action === 'skip') {
                summary.skipped += 1;
                continue;
              }

              if (action === 'rename') {
                targetUri = await this.generateNonConflictUri(targetFolderUri, entry.filename);
                summary.renamed += 1;
              }

              if (action === 'overwrite') {
                summary.overwritten += 1;
              }
            }

            const localBuffer = await this.stagingManager.readStagedBinary(entry.id);
            const binary = new Uint8Array(localBuffer.buffer, localBuffer.byteOffset, localBuffer.byteLength);
            await vscode.workspace.fs.writeFile(targetUri, binary);
            summary.success += 1;
          } catch (error) {
            console.error('[remote-file-transfer] fetch failed', entry, error);
            summary.failed += 1;
          }
        }

        return summary;
      }
    );
  }

  private async askConflictAction(filename: string): Promise<ConflictAction> {
    const selected = await vscode.window.showWarningMessage(
      `目标位置已存在同名文件: ${filename}`,
      { modal: true },
      '覆盖',
      '跳过',
      '自动重命名'
    );

    if (selected === '覆盖') {
      return 'overwrite';
    }

    if (selected === '自动重命名') {
      return 'rename';
    }

    return 'skip';
  }

  private async generateNonConflictUri(baseFolder: vscode.Uri, originalName: string): Promise<vscode.Uri> {
    const parsed = path.posix.parse(originalName);
    let index = 1;

    while (true) {
      const candidateName = `${parsed.name} (${index})${parsed.ext}`;
      const candidateUri = vscode.Uri.joinPath(baseFolder, candidateName);
      const hit = await this.exists(candidateUri);
      if (!hit) {
        return candidateUri;
      }
      index += 1;
    }
  }

  private async exists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch (error) {
      if (isNotFoundError(error)) {
        return false;
      }
      throw error;
    }
  }
}

function isNotFoundError(error: unknown): boolean {
  const message = (error as Error)?.message?.toLowerCase?.() || '';
  const code = (error as { code?: string })?.code;
  return code === 'FileNotFound' || message.includes('not found') || message.includes('no such file');
}
