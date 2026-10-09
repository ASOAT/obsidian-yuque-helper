'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlan, renameState } = require('../sync');

const note = (path, contentHash = 'hash') => ({ path, folder: path.split('/')[0], title: path, contentHash });
const mapped = (folder, id, hash = 'hash') => ({ folder, id, hash, slug: `doc-${id}` });

test('the first sync creates selected notes and never adopts a document by title', () => {
  const plan = createPlan({ selectedFolders: ['Notes'], notes: [note('Notes/first.md'), note('Other/first.md')], state: {} });
  assert.deepEqual(plan.counts, { create: 1, update: 0, delete: 0, skip: 0 });
  assert.equal(plan.upserts[0].note.path, 'Notes/first.md');
  assert.equal(plan.upserts[0].previous, null);
});

test('a paired unchanged note skips; a pending creation with null hash updates its existing id', () => {
  const state = { notes: { 'Notes/a.md': mapped('Notes', 1), 'Notes/b.md': mapped('Notes', 2, null) } };
  const plan = createPlan({ selectedFolders: ['Notes'], notes: [note('Notes/a.md'), note('Notes/b.md')], state });
  assert.deepEqual(plan.counts, { create: 0, update: 1, delete: 0, skip: 1 });
  assert.equal(plan.upserts[0].previous.id, 2);
  assert.equal(state.notes['Notes/b.md'].hash, null);
});

test('deselection cannot delete documents, while a completely scanned empty folder can', () => {
  const state = { notes: { 'Notes/a.md': mapped('Notes', 1), 'Other/b.md': mapped('Other', 2) } };
  const plan = createPlan({ selectedFolders: ['Notes'], notes: [], state });
  assert.deepEqual(plan.removes.map((item) => item.previous.id), [1]);
  assert.equal(createPlan({ selectedFolders: [], notes: [], state }).removes.length, 0);
  assert.equal(createPlan({ selectedFolders: ['Notes'], notes: [], state, allowDeletes: false }).removes.length, 0);
});

test('a missing folder or incomplete scan never purges paired documents', () => {
  const state = { notes: { 'Notes/a.md': mapped('Notes', 1) } };
  assert.equal(createPlan({ selectedFolders: ['Notes'], availableFolders: [], notes: [], state }).removes.length, 0);
  assert.equal(createPlan({ selectedFolders: ['Notes'], scanCompleteFolders: [], notes: [], state }).removes.length, 0);
});

test('same-folder rename preserves remote identity and forces the title/content update', () => {
  const state = { notes: { 'Notes/old.md': mapped('Notes', 1) }, books: { Notes: { id: 10 } } };
  const renamed = renameState(state, 'Notes/old.md', 'Notes/new.md');
  assert.equal(renamed.notes['Notes/new.md'].id, 1);
  assert.equal(renamed.notes['Notes/new.md'].hash, null);
  assert.equal(renamed.notes['Notes/old.md'], undefined);
  assert.equal(state.notes['Notes/old.md'].hash, 'hash');
  const plan = createPlan({ selectedFolders: ['Notes'], notes: [note('Notes/new.md')], state: renamed });
  assert.deepEqual(plan.counts, { create: 0, update: 1, delete: 0, skip: 0 });
});

test('cross-folder move creates a fresh document before the source may be removed', () => {
  const state = { notes: { 'Notes/old.md': mapped('Notes', 1) } };
  const renamed = renameState(state, 'Notes/old.md', 'Projects/new.md');
  assert.equal(renamed.notes['Projects/new.md'], undefined);
  assert.equal(renamed.notes['Notes/old.md'].movedTo, 'Projects/new.md');
  const plan = createPlan({ selectedFolders: ['Notes', 'Projects'], notes: [note('Projects/new.md')], state: renamed });
  assert.deepEqual(plan.counts, { create: 1, update: 0, delete: 1, skip: 0 });
  assert.equal(plan.removes[0].requiresCreatedPath, 'Projects/new.md');
});

test('renaming a paired first-level folder carries its knowledge base and descendants', () => {
  const state = {
    books: { Notes: { id: 10, slug: 'existing-book', owner: 100 } },
    notes: { 'Notes/first.md': mapped('Notes', 1), 'Notes/sub/second.md': mapped('Notes', 2) },
  };
  const renamed = renameState(state, 'Notes', 'Cards');
  assert.equal(renamed.books.Cards.id, 10);
  assert.equal(renamed.books.Notes, undefined);
  assert.equal(renamed.notes['Cards/sub/second.md'].id, 2);
  assert.equal(renamed.notes['Cards/sub/second.md'].folder, 'Cards');
  const plan = createPlan({ selectedFolders: ['Cards'], notes: [note('Cards/first.md'), note('Cards/sub/second.md')], state: renamed });
  assert.deepEqual(plan.counts, { create: 0, update: 2, delete: 0, skip: 0 });
});

test('subfolder rename keeps the book; cross-book subtree movement carries deletion dependencies', () => {
  const state = { notes: { 'Notes/sub/a.md': mapped('Notes', 1), 'Notes/sub/b.md': mapped('Notes', 2) } };
  const renamed = renameState(state, 'Notes/sub', 'Notes/renamed');
  assert.equal(renamed.notes['Notes/renamed/a.md'].id, 1);
  const moved = renameState(state, 'Notes/sub', 'Projects/sub');
  const plan = createPlan({ selectedFolders: ['Notes', 'Projects'], notes: [note('Projects/sub/a.md'), note('Projects/sub/b.md')], state: moved });
  assert.equal(plan.removes[0].requiresCreatedPath, 'Projects/sub/a.md');
  assert.equal(plan.removes[1].requiresCreatedPath, 'Projects/sub/b.md');
});

test('rename collisions fail without overwriting either paired remote identity', () => {
  const state = { books: { Notes: { id: 10 }, Cards: { id: 20 } }, notes: { 'Notes/a.md': mapped('Notes', 1), 'Notes/b.md': mapped('Notes', 2) } };
  assert.throws(() => renameState(state, 'Notes/a.md', 'Notes/b.md'), /overwrite/);
  assert.throws(() => renameState(state, 'Notes', 'Cards'), /merge/);
  assert.equal(state.notes['Notes/a.md'].id, 1);
});

test('same-folder rename carries pending creation slug; cross-folder movement keeps its recovery key', () => {
  const state = { pendingDocs: { 'Notes/a.md': { slug: 'pending-a', folder: 'Notes' } } };
  const renamed = renameState(state, 'Notes/a.md', 'Notes/b.md');
  assert.equal(renamed.pendingDocs['Notes/b.md'].slug, 'pending-a');
  assert.equal(renamed.pendingDocs['Notes/a.md'], undefined);
  const moved = renameState(state, 'Notes/a.md', 'Projects/a.md');
  assert.equal(moved.pendingDocs['Notes/a.md'].slug, 'pending-a');
  assert.equal(moved.pendingDocs['Projects/a.md'], undefined);
  assert.equal(state.pendingDocs['Notes/a.md'].slug, 'pending-a');
});

test('duplicate or inconsistent scan entries fail before unsafe actions are available', () => {
  assert.throws(() => createPlan({ selectedFolders: ['Notes'], notes: [note('Notes/a.md'), note('Notes/a.md')] }), /Duplicate/);
  assert.throws(() => createPlan({ selectedFolders: ['Notes'], notes: [{ ...note('Notes/a.md'), folder: 'Projects' }] }), /first-level/);
});
