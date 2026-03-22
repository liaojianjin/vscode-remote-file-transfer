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
interface HostProbeOptions {
  remoteKind?: string;
  sshHost?: string;
  dockerContainerId?: string;
}
export interface StageContext {
  batchId?: string;
  rootFolderName?: string;
  relativePath?: string;
}
type BatchRootAction = 'overwrite' | 'skip' | 'rename';
interface BatchTargetDecision {
  action: BatchRootAction;
  baseUri?: vscode.Uri;
}

export class TransferBridge {
  constructor(private readonly stagingManager: StagingManager) {}

  public async stageRemoteFile(uri: vscode.Uri, context?: StageContext): Promise<StagingEntry> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const workspaceName = vscode.workspace.getWorkspaceFolder(uri)?.name || 'Unknown';
    const filename = path.posix.basename(uri.path) || path.basename(uri.fsPath) || 'unnamed';
    const sourceMetadata = await resolveSourceMetadata(uri);

    return this.stagingManager.stageBinaryFile(bytes, {
      filename,
      size: bytes.byteLength,
      remoteAuthority: uri.authority,
      remoteHost: sourceMetadata.remoteHost,
      workspaceName,
      path: uri.path,
      dockerContainer: sourceMetadata.dockerContainer,
      dockerContainerId: sourceMetadata.dockerContainerId,
      batchId: context?.batchId,
      rootFolderName: context?.rootFolderName,
      relativePath: context?.relativePath
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
        const batchDecisions = new Map<string, BatchTargetDecision>();

        for (let i = 0; i < total; i += 1) {
          const entry = entries[i];
          progress.report({
            increment: 100 / total,
            message: `${entry.filename} (${i + 1}/${total})`
          });

          try {
            let targetUri: vscode.Uri;
            let skipPerFileConflictPrompt = false;
            if (entry.batchId && entry.rootFolderName && entry.relativePath) {
              const decision = await this.resolveBatchTargetBase(
                targetFolderUri,
                entry,
                batchDecisions
              );
              if (decision.action === 'skip' || !decision.baseUri) {
                summary.skipped += 1;
                continue;
              }

              targetUri = joinRelativePath(decision.baseUri, entry.relativePath);
              skipPerFileConflictPrompt = decision.action === 'overwrite';
            } else {
              targetUri = vscode.Uri.joinPath(targetFolderUri, entry.filename);
            }

            const parentUri = parentDirectoryUri(targetUri);
            await vscode.workspace.fs.createDirectory(parentUri);

            const targetExists = await this.exists(targetUri);

            if (targetExists && !skipPerFileConflictPrompt) {
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
            } else if (targetExists && skipPerFileConflictPrompt) {
              summary.overwritten += 1;
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

  private async resolveBatchTargetBase(
    targetFolderUri: vscode.Uri,
    entry: StagingEntry,
    decisions: Map<string, BatchTargetDecision>
  ): Promise<BatchTargetDecision> {
    const batchId = entry.batchId as string;
    const cached = decisions.get(batchId);
    if (cached) {
      return cached;
    }

    const originalRoot = vscode.Uri.joinPath(targetFolderUri, entry.rootFolderName as string);
    const rootExists = await this.exists(originalRoot);
    if (!rootExists) {
      const decision: BatchTargetDecision = { action: 'overwrite', baseUri: originalRoot };
      decisions.set(batchId, decision);
      return decision;
    }

    const action = await this.askBatchRootConflictAction(entry.rootFolderName as string);
    if (action === 'skip') {
      const decision: BatchTargetDecision = { action: 'skip' };
      decisions.set(batchId, decision);
      return decision;
    }

    if (action === 'rename') {
      const renamedRoot = await this.generateNonConflictFolderUri(
        targetFolderUri,
        entry.rootFolderName as string
      );
      const decision: BatchTargetDecision = { action: 'rename', baseUri: renamedRoot };
      decisions.set(batchId, decision);
      return decision;
    }

    const decision: BatchTargetDecision = { action: 'overwrite', baseUri: originalRoot };
    decisions.set(batchId, decision);
    return decision;
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

  private async askBatchRootConflictAction(folderName: string): Promise<BatchRootAction> {
    const selected = await vscode.window.showWarningMessage(
      `目标位置已存在目录: ${folderName}`,
      { modal: true },
      '覆盖目录',
      '跳过目录',
      '自动重命名目录'
    );

    if (selected === '覆盖目录') {
      return 'overwrite';
    }

    if (selected === '自动重命名目录') {
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

  private async generateNonConflictFolderUri(
    baseFolder: vscode.Uri,
    originalFolderName: string
  ): Promise<vscode.Uri> {
    let index = 1;
    while (true) {
      const candidateName = `${originalFolderName} (${index})`;
      const candidateUri = vscode.Uri.joinPath(baseFolder, candidateName);
      if (!(await this.exists(candidateUri))) {
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

async function resolveSourceMetadata(uri: vscode.Uri): Promise<SourceMetadata> {
  const authority = uri.authority;
  const plusIndex = authority.indexOf('+');
  if (plusIndex <= 0 || plusIndex >= authority.length - 1) {
    return {
      remoteHost: await resolveRemoteHostname(uri, {})
    };
  }

  const remoteKind = authority.slice(0, plusIndex);
  const rawPayload = authority.slice(plusIndex + 1);
  const decodedPayload = safeDecode(rawPayload).split('?')[0].trim();
  if (!decodedPayload) {
    return {
      remoteHost: await resolveRemoteHostname(uri, {})
    };
  }

  if (remoteKind === 'ssh-remote') {
    return {
      remoteHost: await resolveRemoteHostname(
        uri,
        { remoteKind, sshHost: decodedPayload },
        decodedPayload
      )
    };
  }

  if (remoteKind !== 'attached-container' && remoteKind !== 'dev-container') {
    return {
      remoteHost: await resolveRemoteHostname(uri, { remoteKind })
    };
  }

  const dockerContainerId = extractContainerId(decodedPayload);
  const dockerContainerName = dockerContainerId
    ? resolveDockerFriendlyName(dockerContainerId)
    : undefined;
  const remoteHost = await resolveRemoteHostname(
    uri,
    { remoteKind, dockerContainerId },
    extractRemoteHost(decodedPayload)
  );

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

const remoteHostCache = new Map<string, string>();

async function resolveRemoteHostname(
  uri: vscode.Uri,
  probeOptions: HostProbeOptions,
  fallback?: string
): Promise<string | undefined> {
  const cacheKey = uri.authority;
  const cached = remoteHostCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const fromCommand = runHostnameCommand(probeOptions);
  if (fromCommand) {
    remoteHostCache.set(cacheKey, fromCommand);
    return fromCommand;
  }

  if (uri.scheme === 'file') {
    const localHost = runCommand('hostname', [], 800);
    if (localHost) {
      remoteHostCache.set(cacheKey, localHost);
      return localHost;
    }
  }

  const fromRemote = await readHostnameFromRemoteFiles(uri);
  if (fromRemote) {
    remoteHostCache.set(cacheKey, fromRemote);
  }
  return fromRemote || fallback;
}

function runHostnameCommand(options: HostProbeOptions): string | undefined {
  if (options.dockerContainerId) {
    const viaDocker = runCommand(
      'docker',
      ['exec', options.dockerContainerId, 'hostname'],
      1500
    );
    if (viaDocker) {
      return viaDocker;
    }
  }

  if (options.sshHost) {
    const viaSsh = runCommand(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=2', options.sshHost, 'hostname'],
      2500
    );
    if (viaSsh) {
      return viaSsh;
    }
  }

  return undefined;
}

function runCommand(command: string, args: string[], timeout: number): string | undefined {
  try {
    const output = execFileSync(command, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout
    });
    const value = output.trim().split(/\r?\n/)[0]?.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function joinRelativePath(baseUri: vscode.Uri, relativePath: string): vscode.Uri {
  const segments = relativePath.split('/').filter(Boolean);
  return vscode.Uri.joinPath(baseUri, ...segments);
}

function parentDirectoryUri(uri: vscode.Uri): vscode.Uri {
  const parentPath = path.posix.dirname(uri.path);
  return uri.with({ path: parentPath });
}

async function readHostnameFromRemoteFiles(uri: vscode.Uri): Promise<string | undefined> {
  const candidates = ['/etc/hostname', '/proc/sys/kernel/hostname'];
  for (const candidatePath of candidates) {
    try {
      const candidateUri = uri.with({ path: candidatePath, query: '', fragment: '' });
      const bytes = await vscode.workspace.fs.readFile(candidateUri);
      const value = Buffer.from(bytes).toString('utf-8').trim().split(/\r?\n/)[0]?.trim();
      if (value) {
        return value;
      }
    } catch {
      // try next candidate
    }
  }
  return undefined;
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
