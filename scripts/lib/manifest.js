'use strict';

function safeCell(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

function parseManifestLine(line) {
  const [modId, name, ver, note, fileId, action] = String(line || '').split('\t');
  return { modId: modId || '', name: name || '', ver: ver || '', note: note || '', fileId: fileId || '', action: action || '' };
}

function formatManifestLine(row) {
  return [row.modId, row.name, row.ver, row.note, row.fileId, row.action].map(safeCell).join('\t');
}

function parseManifestText(text, { includeComments = false } = {}) {
  return String(text || '').split(/\r?\n/)
    .filter(line => line.trim() && (includeComments || !line.startsWith('#')))
    .map(parseManifestLine);
}

function formatManifest(rows) {
  return rows.map(formatManifestLine).join('\n') + (rows.length ? '\n' : '');
}

function transactionId(row) {
  const m = String(row.note || '').match(/(?:^|;\s*)tx=([^;\s]+)/);
  return m ? m[1] : `${row.modId}:${row.fileId}`;
}

module.exports = { safeCell, parseManifestLine, formatManifestLine, parseManifestText, formatManifest, transactionId };
