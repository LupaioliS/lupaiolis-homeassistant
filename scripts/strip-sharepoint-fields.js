#!/usr/bin/env node
// Rimuove i campi di servizio SharePoint da un export JSON (array di oggetti).
// Uso: node strip-sharepoint-fields.js input.json [output.json]
// Senza output.json scrive input.cleaned.json

const fs = require('fs');
const path = require('path');

const FIELDS = [
  'Author',
  'Author#Claims',
  'Editor',
  'Editor#Claims',
  'Modified',
  'Created',
  '{Identifier}',
  '{IsFolder}',
  '{Thumbnail}',
  '{Link}',
  '{Name}',
  '{FilenameWithExtension}',
  '{Path}',
  '{FullPath}',
  '{ContentType}',
  '{ContentType}#Id',
  '{HasAttachments}',
  '{VersionNumber}',
];

const input = process.argv[2];
if (!input) {
  console.error('Uso: node strip-sharepoint-fields.js input.json [output.json]');
  process.exit(1);
}

const output =
  process.argv[3] ||
  path.join(
    path.dirname(input),
    path.basename(input, path.extname(input)) + '.cleaned' + (path.extname(input) || '.json')
  );

const data = JSON.parse(fs.readFileSync(input, 'utf8'));
const rows = Array.isArray(data) ? data : [data];

for (const row of rows) {
  for (const field of FIELDS) delete row[field];
}

fs.writeFileSync(output, JSON.stringify(Array.isArray(data) ? rows : rows[0], null, 2), 'utf8');
console.log(`${rows.length} record puliti -> ${output}`);
