import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
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
interface SourceMetadata {
  remoteHost?: string;
  dockerContainer?: string;
  dockerContainerId?: string;
}

export class TransferBridge {
  constructor(private readonly stagingManager: StagingManager) {}

  public async stageRemoteFile(uri: vscode.Uri): Promise<StagingEntry> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const workspaceName = vscode.workspace.getWorkspaceFolder(uri)?.name || 'Unknown';
    const filename = path.posix.basename(uri.path) || path.basename(uri.fsPath) || 'unnamed';
    const sourceMetadata = resolveSourceMetadata(uri.authority);

    return this.stagingManager.stageBinaryFile(bytes, {
      filename,
      size: bytes.byteLength,
      remoteAuthority: uri.authority,
      remoteHost: sourceMetadata.remoteHost,
      workspaceName,
      path: uri.path,
      dockerContainer: sourceMetadata.dockerContainer,
      dockerContainerId: sourceMetadata.dockerContainerId
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

function resolveSourceMetadata(authority: string): SourceMetadata {
  const plusIndex = authority.indexOf('+');
  if (plusIndex <= 0 || plusIndex >= authority.length - 1) {
    return {};
  }

  const remoteKind = authority.slice(0, plusIndex);
  const rawPayload = authority.slice(plusIndex + 1);
  const decodedPayload = safeDecode(rawPayload).split('?')[0].trim();
  if (!decodedPayload) {
    return {};
  }

  if (remoteKind === 'ssh-remote') {
    return { remoteHost: decodedPayload };
  }

  if (remoteKind !== 'attached-container' && remoteKind !== 'dev-container') {
    return {};
  }

  const dockerContainerId = extractContainerId(decodedPayload);
  const dockerContainerName = dockerContainerId
    ? resolveDockerFriendlyName(dockerContainerId)
    : undefined;
  const remoteHost = extractRemoteHost(decodedPayload);

  return {
    remoteHost,
    dockerContainerId,
    dockerContainer: dockerContainerName || buildFallbackContainerLabel(remoteKind, dockerContainerId, decodedPayload)
  };
}

function extractContainerId(payload: string): string | undefined {
  const exactHex = payload.match(/[a-f0-9]{64}/i)?.[0];
  if (exactHex) {
    return exactHex.toLowerCase();
  }

  const shortHex = payload.match(/[a-f0-9]{12,63}/i)?.[0];
  if (shortHex) {
    return shortHex.toLowerCase();
  }

  return undefined;
}

function buildFallbackContainerLabel(kind: string, containerId: string | undefined, payload: string): string {
  if (containerId) {
    return `${kind}:${containerId.slice(0, 12)}`;
  }
  return `${kind}:${shorten(payload)}`;
}

function extractRemoteHost(payload: string): string | undefined {
  const sshTokenMatch = payload.match(/ssh-remote\+([A-Za-z0-9._-]+)/);
  if (sshTokenMatch) {
    return safeDecode(sshTokenMatch[1]);
  }

  const urlHostMatch = payload.match(/ssh:\/\/[^@]+@([A-Za-z0-9._-]+)/);
  if (urlHostMatch) {
    return urlHostMatch[1];
  }

  const hostFieldMatch = payload.match(/(?:host|hostname)[:=]([A-Za-z0-9._-]+)/i);
  if (hostFieldMatch) {
    return hostFieldMatch[1];
  }

  return undefined;
}

const dockerNameCache = new Map<string, string | null>();

function resolveDockerFriendlyName(containerId: string): string | undefined {
  const cached = dockerNameCache.get(containerId);
  if (typeof cached !== 'undefined') {
    return cached || undefined;
  }

  const fromInspect = inspectDockerName(containerId);
  if (fromInspect) {
    dockerNameCache.set(containerId, fromInspect);
    return fromInspect;
  }

  const fromPs = resolveDockerNameFromPs(containerId);
  dockerNameCache.set(containerId, fromPs || null);
  return fromPs;
}

function inspectDockerName(containerId: string): string | undefined {
  try {
    const output = execFileSync(
      'docker',
      ['inspect', '--format', '{{.Name}}', containerId],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 }
    ).trim();
    if (!output) {
      return undefined;
    }
    return output.replace(/^\//, '');
  } catch {
    return undefined;
  }
}

function resolveDockerNameFromPs(containerId: string): string | undefined {
  try {
    const output = execFileSync(
      'docker',
      ['ps', '-a', '--no-trunc', '--format', '{{.ID}}\\t{{.Names}}'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 }
    );

    const lines = output.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const [id, name] = line.split('\t');
      if (!id || !name) {
        continue;
      }
      if (id.toLowerCase().startsWith(containerId.toLowerCase())) {
        return name;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function shorten(value: string): string {
  if (value.length <= 36) {
    return value;
  }
  return `${value.slice(0, 24)}...${value.slice(-8)}`;
}
