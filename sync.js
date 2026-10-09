'use strict';

// This module deliberately knows nothing about the vault, browser session, or HTTP.
// Only documents recorded by this plugin can become delete candidates.
function folderOf(path) {
  return String(path).split('/')[0];
}

function normalizedPath(value) {
  if (typeof value !== 'string' || !value) throw new TypeError('A non-empty vault path is required');
  const path = value.replace(/\\/g, '/').replace(/\/$/, '');
  if (path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new TypeError('Expected a relative vault path');
  }
  return path;
}

function setOf(values) {
  if (!Array.isArray(values)) throw new TypeError('Folder selections must be arrays');
  return new Set(values.map(normalizedPath));
}

function hasDocumentId(record) {
  return Boolean(record && (record.id || record.docId));
}

/**
 * Plan only; never mutate input state or perform remote operations.
 * selectedFolders must consist of existing, completely scanned first-level folders.
 * Callers that have a broader selection can provide availableFolders and
 * scanCompleteFolders to explicitly restrict destructive work.
 */
function createPlan({ selectedFolders = [], notes = [], state = {}, allowDeletes = true,
  availableFolders, scanCompleteFolders } = {}) {
  const selected = setOf(selectedFolders);
  const available = availableFolders === undefined ? selected : setOf(availableFolders);
  const complete = scanCompleteFolders === undefined ? selected : setOf(scanCompleteFolders);
  const safeFolders = new Set([...selected].filter((folder) => available.has(folder) && complete.has(folder)));
  const mappings = state.notes || {};
  const scannedPaths = new Set();
  const upserts = [];
  const unchanged = [];
  const removes = [];

  if (!Array.isArray(notes)) throw new TypeError('Notes must be an array');
  for (const input of notes) {
    const path = normalizedPath(input.path);
    const folder = normalizedPath(input.folder || folderOf(path));
    if (folder.includes('/') || folderOf(path) !== folder || !path.includes('/')) {
      throw new TypeError('Each note must belong to its first-level folder');
    }
    if (scannedPaths.has(path)) throw new Error(`Duplicate note in scan: ${path}`);
    scannedPaths.add(path);
    if (!safeFolders.has(folder)) continue;
    const note = { ...input, path, folder };
    const previous = mappings[path] ? { ...mappings[path] } : null;
    const matchesFolder = previous && previous.folder === folder;
    const action = hasDocumentId(previous) && matchesFolder ? 'update' : 'create';
    // A null hash represents an interrupted creation or an unconfirmed write.
    // It must be updated even when both hashes happen to be null/undefined.
    if (action === 'update' && typeof note.contentHash === 'string' && note.contentHash.length > 0 &&
      previous.hash === note.contentHash) {
      unchanged.push({ note, previous });
    } else {
      upserts.push({ action, note, previous });
    }
  }

  if (allowDeletes) {
    for (const [path, record] of Object.entries(mappings)) {
      if (!record || !safeFolders.has(record.folder) || scannedPaths.has(path) || !hasDocumentId(record)) continue;
      const remove = { path, previous: { ...record }, reason: record.movedTo ? 'moved' : 'missing' };
      // The executor must finish the destination creation before this deletion.
      if (record.movedTo && safeFolders.has(folderOf(record.movedTo))) remove.requiresCreatedPath = record.movedTo;
      removes.push(remove);
    }
  }

  upserts.sort((a, b) => a.note.path.localeCompare(b.note.path));
  unchanged.sort((a, b) => a.note.path.localeCompare(b.note.path));
  removes.sort((a, b) => a.path.localeCompare(b.path));
  return {
    upserts, removes, unchanged,
    counts: {
      create: upserts.filter((item) => item.action === 'create').length,
      update: upserts.filter((item) => item.action === 'update').length,
      delete: removes.length,
      skip: unchanged.length,
    },
  };
}

/**
 * Preserve remote identity during Obsidian rename events.
 * A top-level mapped folder rename carries its book mapping with it.
 * A move between existing folders retains the source until destination creation
 * succeeds; the planner emits a deletion dependency via requiresCreatedPath.
 */
function renameState(state = {}, oldValue, newValue) {
  const oldPath = normalizedPath(oldValue);
  const newPath = normalizedPath(newValue);
  const next = { ...state, books: { ...(state.books || {}) }, notes: { ...(state.notes || {}) } };
  if (state.pendingDocs) next.pendingDocs = { ...state.pendingDocs };
  if (oldPath === newPath) return next;
  const isBookRename = !oldPath.includes('/') && !newPath.includes('/') &&
    Object.prototype.hasOwnProperty.call(next.books, oldPath);
  if (isBookRename && Object.prototype.hasOwnProperty.call(next.books, newPath)) {
    throw new Error('Cannot merge two paired knowledge bases by renaming a folder');
  }
  const entries = Object.entries(next.notes).filter(([path]) => path === oldPath || path.startsWith(`${oldPath}/`));
  const movedPaths = new Set(entries.map(([path]) => path));
  for (const [path] of entries) {
    const targetPath = `${newPath}${path.slice(oldPath.length)}`;
    if (Object.prototype.hasOwnProperty.call(next.notes, targetPath) && !movedPaths.has(targetPath)) {
      throw new Error(`Cannot overwrite an existing paired note: ${targetPath}`);
    }
  }
  if (isBookRename) {
    next.books[newPath] = { ...next.books[oldPath] };
    delete next.books[oldPath];
  }
  for (const [path, record] of entries) {
    const targetPath = `${newPath}${path.slice(oldPath.length)}`;
    const targetFolder = folderOf(targetPath);
    if (isBookRename || record.folder === targetFolder) {
      next.notes[targetPath] = { ...record, folder: targetFolder, hash: null };
      delete next.notes[targetPath].movedTo;
      delete next.notes[path];
    } else {
      next.notes[path] = { ...record, movedTo: targetPath };
    }
  }
  for (const [path, record] of Object.entries(next.pendingDocs || {})) {
    if (path !== oldPath && !path.startsWith(`${oldPath}/`)) continue;
    const targetPath = `${newPath}${path.slice(oldPath.length)}`;
    const targetFolder = folderOf(targetPath);
    if (!isBookRename && folderOf(path) !== targetFolder) continue;
    if (Object.prototype.hasOwnProperty.call(next.pendingDocs, targetPath)) {
      throw new Error(`Cannot overwrite a pending paired note: ${targetPath}`);
    }
    next.pendingDocs[targetPath] = { ...record };
    if (Object.prototype.hasOwnProperty.call(record, 'folder')) next.pendingDocs[targetPath].folder = targetFolder;
    delete next.pendingDocs[path];
  }
  return next;
}

module.exports = { createPlan, renameState, folderOf };
