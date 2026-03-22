import * as path from 'node:path';
import * as vscode from 'vscode';
import { StagingEntry, StagingManager } from './StagingManager';

type StagingViewItemKind = 'placeholder' | 'folder' | 'file';

interface StagingViewItemOptions {
  id: string;
  kind: StagingViewItemKind;
  label: string;
  entries: StagingEntry[];
  description?: string;
  tooltip?: vscode.MarkdownString;
  children?: StagingViewItem[];
}

interface FolderTreeNode {
  name: string;
  path: string;
  entries: StagingEntry[];
  folders: Map<string, FolderTreeNode>;
  files: StagingEntry[];
}

export class StagingViewItem extends vscode.TreeItem {
  public readonly kind: StagingViewItemKind;
  public readonly entries: StagingEntry[];
  public readonly children: StagingViewItem[];

  constructor(options: StagingViewItemOptions) {
    super(
      options.label,
      options.kind === 'folder'
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    this.id = options.id;
    this.kind = options.kind;
    this.entries = options.entries;
    this.children = options.children ?? [];
    this.description = options.description;
    this.tooltip = options.tooltip;

    if (options.kind === 'file') {
      this.contextValue = 'stagedFile';
      this.iconPath = new vscode.ThemeIcon('file');
    } else if (options.kind === 'folder') {
      this.contextValue = 'stagedFolder';
      this.iconPath = new vscode.ThemeIcon('folder');
    } else {
      this.contextValue = 'stagedPlaceholder';
      this.iconPath = new vscode.ThemeIcon('info');
    }
  }
}

export class StagingViewProvider implements vscode.TreeDataProvider<StagingViewItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<StagingViewItem | undefined>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private rootItems: StagingViewItem[] = [];

  constructor(private readonly stagingManager: StagingManager) {}

  public refresh(): void {
    this.rootItems = [];
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public getTreeItem(element: StagingViewItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: StagingViewItem): Promise<StagingViewItem[]> {
    if (element) {
      return element.children;
    }

    let entries: StagingEntry[] = [];
    try {
      entries = await this.stagingManager.listEntries();
    } catch {
      this.rootItems = [buildPlaceholderItem('读取暂存池失败')];
      return this.rootItems;
    }

    if (entries.length === 0) {
      this.rootItems = [buildPlaceholderItem('全局池为空')];
      return this.rootItems;
    }

    this.rootItems = buildRootItems(entries);
    return this.rootItems;
  }
}

function buildRootItems(entries: StagingEntry[]): StagingViewItem[] {
  const standalone: StagingEntry[] = [];
  const batchGroups = new Map<string, StagingEntry[]>();

  for (const entry of entries) {
    if (entry.batchId && entry.rootFolderName && entry.relativePath) {
      const groupKey = `${entry.batchId}::${entry.rootFolderName}`;
      const groupEntries = batchGroups.get(groupKey) ?? [];
      groupEntries.push(entry);
      batchGroups.set(groupKey, groupEntries);
    } else {
      standalone.push(entry);
    }
  }

  const items: StagingViewItem[] = [];

  for (const [groupKey, groupEntries] of batchGroups.entries()) {
    const rootFolderName = groupEntries[0].rootFolderName as string;
    const rootNode = createFolderNode(rootFolderName, rootFolderName, groupEntries);

    for (const entry of groupEntries) {
      addEntryToTree(rootNode, entry);
    }

    items.push(
      buildFolderItem(rootNode, groupEntries, {
        idPrefix: `batch:${groupKey}`,
        isBatchRoot: true
      })
    );
  }

  for (const entry of standalone) {
    items.push(buildStandaloneFileItem(entry));
  }

  return items.sort((a, b) => {
    const aTime = Math.max(...a.entries.map((entry) => entry.timestamp));
    const bTime = Math.max(...b.entries.map((entry) => entry.timestamp));
    return bTime - aTime;
  });
}

function createFolderNode(name: string, fullPath: string, seedEntries: StagingEntry[]): FolderTreeNode {
  return {
    name,
    path: fullPath,
    entries: [...seedEntries],
    folders: new Map<string, FolderTreeNode>(),
    files: []
  };
}

function addEntryToTree(root: FolderTreeNode, entry: StagingEntry): void {
  const relative = entry.relativePath ?? entry.filename;
  const segments = relative.split('/').filter(Boolean);
  if (segments.length === 0) {
    root.files.push(entry);
    return;
  }

  let cursor = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const folderName = segments[index];
    let child = cursor.folders.get(folderName);
    if (!child) {
      child = createFolderNode(folderName, `${cursor.path}/${folderName}`, []);
      cursor.folders.set(folderName, child);
    }
    child.entries.push(entry);
    cursor = child;
  }

  cursor.files.push(entry);
}

function buildFolderItem(
  node: FolderTreeNode,
  allEntries: StagingEntry[],
  options: { idPrefix: string; isBatchRoot: boolean }
): StagingViewItem {
  const children: StagingViewItem[] = [];

  const folderChildren = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const folderNode of folderChildren) {
    children.push(
      buildFolderItem(folderNode, folderNode.entries, {
        idPrefix: `${options.idPrefix}/${folderNode.name}`,
        isBatchRoot: false
      })
    );
  }

  const fileChildren = [...node.files].sort((a, b) => {
    const aName = a.relativePath ?? a.filename;
    const bName = b.relativePath ?? b.filename;
    return aName.localeCompare(bName);
  });
  for (const entry of fileChildren) {
    children.push(buildBatchFileItem(entry));
  }

  const sourceEntry = allEntries[0];
  const folderLabel = options.isBatchRoot ? node.name : path.posix.basename(node.path);
  const descriptionSegments = [`${countFiles(allEntries)} files`];
  if (options.isBatchRoot) {
    const sourceText = buildSourceDescription(sourceEntry);
    if (sourceText) {
      descriptionSegments.push(sourceText);
    }
  }

  return new StagingViewItem({
    id: `${options.idPrefix}`,
    kind: 'folder',
    label: folderLabel,
    entries: allEntries,
    description: descriptionSegments.join(' | '),
    tooltip: buildFolderTooltip(folderLabel, allEntries, sourceEntry, options.isBatchRoot),
    children
  });
}

function buildBatchFileItem(entry: StagingEntry): StagingViewItem {
  const relative = entry.relativePath ?? entry.filename;
  const parentPath = path.posix.dirname(relative);
  return new StagingViewItem({
    id: `file:${entry.id}`,
    kind: 'file',
    label: path.posix.basename(relative),
    entries: [entry],
    description: parentPath && parentPath !== '.' ? parentPath : undefined,
    tooltip: buildFileTooltip(entry)
  });
}

function buildStandaloneFileItem(entry: StagingEntry): StagingViewItem {
  return new StagingViewItem({
    id: `file:${entry.id}`,
    kind: 'file',
    label: entry.filename,
    entries: [entry],
    description: buildSourceDescription(entry),
    tooltip: buildFileTooltip(entry)
  });
}

function buildPlaceholderItem(message: string): StagingViewItem {
  return new StagingViewItem({
    id: `placeholder:${message}`,
    kind: 'placeholder',
    label: message,
    entries: []
  });
}

function buildSourceDescription(entry: StagingEntry): string {
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

function buildFolderTooltip(
  label: string,
  entries: StagingEntry[],
  sourceEntry: StagingEntry,
  isBatchRoot: boolean
): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**📁 ${escapeMarkdown(label)}**  \n`);
  md.appendMarkdown(`- Files: ${countFiles(entries)}  \n`);

  if (isBatchRoot) {
    md.appendMarkdown(`- Workspace: ${escapeMarkdown(sourceEntry.workspaceName)}  \n`);
    const host = resolveHostForDisplay(sourceEntry);
    if (host) {
      md.appendMarkdown(`- Host: ${escapeMarkdown(host)}  \n`);
    }
    if (sourceEntry.dockerContainer) {
      md.appendMarkdown(`- Docker: ${escapeMarkdown(sourceEntry.dockerContainer)}  \n`);
    }
    md.appendMarkdown(`- Authority: ${escapeMarkdown(sourceEntry.remoteAuthority)}  \n`);
  }

  const latestTimestamp = Math.max(...entries.map((entry) => entry.timestamp));
  md.appendMarkdown(`- Latest Staged At: ${new Date(latestTimestamp).toLocaleString()}`);
  return md;
}

function buildFileTooltip(entry: StagingEntry): vscode.MarkdownString {
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

function countFiles(entries: StagingEntry[]): number {
  return entries.length;
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
