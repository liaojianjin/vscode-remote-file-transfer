import * as vscode from 'vscode';
import { StagingEntry, StagingManager } from './StagingManager';

export class StagingViewItem extends vscode.TreeItem {
  constructor(public readonly entry: StagingEntry) {
    super(resolveLabel(entry), vscode.TreeItemCollapsibleState.None);
    this.id = entry.id;
    const isPlaceholder = entry.id.startsWith('__placeholder_');
    this.contextValue = isPlaceholder ? 'stagedPlaceholder' : 'stagedEntry';
    this.description = buildDescription(entry);
    this.iconPath = isPlaceholder ? new vscode.ThemeIcon('info') : new vscode.ThemeIcon('file');
    this.tooltip = buildTooltip(entry);
  }
}

export class StagingViewProvider implements vscode.TreeDataProvider<StagingViewItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<StagingViewItem | undefined>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(private readonly stagingManager: StagingManager) {}

  public refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public getTreeItem(element: StagingViewItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(): Promise<StagingViewItem[]> {
    let entries: StagingEntry[] = [];
    try {
      entries = await this.stagingManager.listEntries();
    } catch {
      return [new StagingViewItem(errorPlaceholderEntry())];
    }

    if (entries.length === 0) {
      return [new StagingViewItem(emptyPlaceholderEntry())];
    }

    return entries.map((entry) => new StagingViewItem(entry));
  }
}

function buildDescription(entry: StagingEntry): string {
  const segments = [entry.workspaceName];
  const host = resolveHostForDisplay(entry);
  if (host) {
    segments.push(`Host: ${host}`);
  }
  if (entry.dockerContainer) {
    segments.push(`Docker: ${entry.dockerContainer}`);
  }
  return segments.join(' | ');
}

function buildTooltip(entry: StagingEntry): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**${escapeMarkdown(entry.filename)}**  \n`);
  md.appendMarkdown(`- Workspace: ${escapeMarkdown(entry.workspaceName)}  \n`);
  md.appendMarkdown(`- Authority: ${escapeMarkdown(entry.remoteAuthority)}  \n`);
  const host = resolveHostForDisplay(entry);
  if (host) {
    md.appendMarkdown(`- Host: ${escapeMarkdown(host)}  \n`);
  }
  if (entry.dockerContainer) {
    md.appendMarkdown(`- Docker: ${escapeMarkdown(entry.dockerContainer)}  \n`);
  }
  md.appendMarkdown(`- Path: ${escapeMarkdown(entry.path)}  \n`);
  if (entry.rootFolderName && entry.relativePath) {
    md.appendMarkdown(`- Relative: ${escapeMarkdown(`${entry.rootFolderName}/${entry.relativePath}`)}  \n`);
  }
  md.appendMarkdown(`- Size: ${formatBytes(entry.size)}  \n`);
  md.appendMarkdown(`- Staged At: ${new Date(entry.timestamp).toLocaleString()}`);
  return md;
}

function resolveLabel(entry: StagingEntry): string {
  if (entry.rootFolderName && entry.relativePath) {
    return `${entry.rootFolderName}/${entry.relativePath}`;
  }
  return entry.filename;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/`/g, '\\`');
}

function resolveHostForDisplay(entry: StagingEntry): string | undefined {
  if (entry.remoteHost && entry.remoteHost.trim()) {
    return entry.remoteHost;
  }

  const authority = entry.remoteAuthority;
  const plusIndex = authority.indexOf('+');
  if (plusIndex > 0 && plusIndex < authority.length - 1) {
    const remoteKind = authority.slice(0, plusIndex);
    const payload = safeDecode(authority.slice(plusIndex + 1));
    if (remoteKind === 'ssh-remote') {
      return payload;
    }

    const sshTokenMatch = payload.match(/ssh-remote\+([A-Za-z0-9._-]+)/);
    if (sshTokenMatch) {
      return safeDecode(sshTokenMatch[1]);
    }
  }

  return undefined;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function emptyPlaceholderEntry(): StagingEntry {
  return {
    id: '__placeholder_empty__',
    filename: '全局池为空',
    size: 0,
    remoteAuthority: 'N/A',
    workspaceName: 'N/A',
    path: '无暂存文件',
    timestamp: Date.now()
  };
}

function errorPlaceholderEntry(): StagingEntry {
  return {
    id: '__placeholder_error__',
    filename: '读取暂存池失败',
    size: 0,
    remoteAuthority: 'N/A',
    workspaceName: 'N/A',
    path: '请稍后刷新重试',
    timestamp: Date.now()
  };
}
