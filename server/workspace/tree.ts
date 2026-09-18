import path from "node:path";
import type { FileNode } from "../schemas/event-schemas.js";

// -------------
// The file tree shape
// -------------

/**
 * Build a hierarchical file tree (the `filetree.updated` payload) from a
 * flat list of workspace-relative POSIX paths. Directories become nodes
 * containing their children; files carry their last-modified time. Pure:
 * WorkspaceFiles supplies the list (`fileTree`), tests can supply their own.
 */
export function buildFileTree(files: Array<{ path: string; lastModified: string }>): FileNode[] {
  const tree: FileNode[] = [];
  const dirMap = new Map<string, FileNode>();

  // Sort files to ensure directories are created before their children
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));

  for (const file of sorted) {
    appendFile(tree, dirMap, file);
  }

  return tree;
}

function appendFile(
  tree: FileNode[],
  dirMap: Map<string, FileNode>,
  file: { path: string; lastModified: string },
): void {
  // Normalize path to remove leading "./"
  const normalizedPath = file.path.startsWith("./") ? file.path.slice(2) : file.path;
  // Glob patterns always use forward slashes, even on Windows
  const parts = normalizedPath.split("/");
  let currentPath = "";
  let parent: FileNode | null = null;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string;
    currentPath = currentPath ? path.join(currentPath, part) : part;

    if (i === parts.length - 1) {
      const fileNode: FileNode = {
        name: part,
        path: currentPath,
        isDirectory: false,
        lastModified: file.lastModified,
        children: [], // Empty array for files
      };
      attachNode(tree, parent, fileNode);
    } else {
      if (!dirMap.has(currentPath)) {
        const dirNode: FileNode = {
          name: part,
          path: currentPath,
          isDirectory: true,
          children: [],
        };
        dirMap.set(currentPath, dirNode);
        attachNode(tree, parent, dirNode);
      }
      parent = dirMap.get(currentPath) || null;
    }
  }
}

function attachNode(tree: FileNode[], parent: FileNode | null, node: FileNode): void {
  if (parent) {
    parent.children ??= [];
    parent.children.push(node);
  } else tree.push(node);
}
