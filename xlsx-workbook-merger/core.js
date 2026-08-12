const WHITESPACE_RE = /\s+/g;

export const MAX_HEADER_SCAN_ROWS = 50;
export const MAX_SUPPORTED_COLUMNS = 1024;
export const MIN_HEADER_SIMILARITY = 0.5;

export function isXlsxFilename(filename) {
  return typeof filename === 'string' && /\.xlsx$/i.test(filename.trim());
}

export function fileIdentity(file) {
  return `${file?.name ?? ''}\u0000${file?.size ?? ''}\u0000${file?.lastModified ?? ''}`;
}

export function appendUniqueXlsxFiles(existingFiles = [], incomingFiles = []) {
  const files = [...existingFiles];
  const seen = new Set(files.map(fileIdentity));
  let addedCount = 0;
  let duplicateCount = 0;
  let invalidCount = 0;

  for (const file of incomingFiles) {
    if (!file || !isXlsxFilename(file.name)) {
      invalidCount += 1;
      continue;
    }
    const key = fileIdentity(file);
    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(key);
    files.push(file);
    addedCount += 1;
  }

  return { files, addedCount, duplicateCount, invalidCount };
}

export function headerValueToText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value.richText)) {
    return value.richText.map((part) => part?.text ?? '').join('');
  }
  if (value.text !== undefined && value.text !== null) return String(value.text);
  if (value.result !== undefined && value.result !== null) return headerValueToText(value.result);
  if (value.formula !== undefined && value.formula !== null) return String(value.formula);
  if (value.hyperlink !== undefined && value.hyperlink !== null) return String(value.hyperlink);
  return String(value);
}

export function normalizeHeader(value) {
  return headerValueToText(value)
    .normalize('NFKC')
    .trim()
    .replace(WHITESPACE_RE, ' ')
    .toLocaleLowerCase();
}

export function buildHeaderEntries(values) {
  let lastNamedIndex = -1;
  const normalized = values.map((value, index) => {
    const text = normalizeHeader(value);
    if (text) lastNamedIndex = index;
    return text;
  });

  if (lastNamedIndex < 0) {
    return { entries: [], namedCount: 0, duplicateCount: 0 };
  }

  const occurrences = new Map();
  let duplicateCount = 0;
  const entries = [];

  for (let index = 0; index <= lastNamedIndex; index += 1) {
    const normalizedName = normalized[index];
    const sourceColumn = index + 1;
    if (!normalizedName) {
      entries.push({
        key: `blank:${sourceColumn}`,
        normalizedName: '',
        rawValue: values[index] ?? null,
        sourceColumn,
        isBlank: true,
      });
      continue;
    }

    const occurrence = (occurrences.get(normalizedName) ?? 0) + 1;
    occurrences.set(normalizedName, occurrence);
    if (occurrence > 1) duplicateCount += 1;
    entries.push({
      key: `header:${normalizedName}:${occurrence}`,
      normalizedName,
      rawValue: values[index],
      sourceColumn,
      isBlank: false,
    });
  }

  return {
    entries,
    namedCount: entries.filter((entry) => !entry.isBlank).length,
    duplicateCount,
  };
}

function isTextLike(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (!value || typeof value !== 'object') return false;
  return Array.isArray(value.richText) || value.text !== undefined || value.hyperlink !== undefined;
}

function candidateScore(candidate, referenceEntries) {
  const built = buildHeaderEntries(candidate.values);
  if (built.namedCount < 2) return null;

  const textLikeCount = candidate.values.filter(isTextLike).length;
  const earlyRowBonus = Math.max(0, MAX_HEADER_SCAN_ROWS - candidate.rowNumber) * 0.03;

  if (!referenceEntries?.length) {
    const score =
      built.namedCount * 1.5 +
      textLikeCount * 1.25 -
      built.duplicateCount * 2 +
      earlyRowBonus;
    return { ...candidate, ...built, score, matchedNamedCount: 0, similarity: 0 };
  }

  const referenceNamed = referenceEntries.filter((entry) => !entry.isBlank);
  const referenceColumns = new Map(referenceNamed.map((entry) => [entry.key, entry.outputColumn ?? entry.sourceColumn]));
  const sourceNamed = built.entries.filter((entry) => !entry.isBlank);
  let matchedNamedCount = 0;
  let positionalMatches = 0;

  for (const entry of sourceNamed) {
    if (!referenceColumns.has(entry.key)) continue;
    matchedNamedCount += 1;
    if (referenceColumns.get(entry.key) === entry.sourceColumn) positionalMatches += 1;
  }

  const denominator = Math.min(referenceNamed.length, sourceNamed.length);
  const similarity = denominator > 0 ? matchedNamedCount / denominator : 0;
  const score =
    similarity * 1000 +
    matchedNamedCount * 5 +
    positionalMatches +
    textLikeCount * 0.1 +
    earlyRowBonus;

  return { ...candidate, ...built, score, matchedNamedCount, similarity };
}

export function selectHeaderCandidate(candidates, referenceEntries = []) {
  const scored = candidates
    .map((candidate) => candidateScore(candidate, referenceEntries))
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || left.rowNumber - right.rowNumber);

  if (!scored.length) {
    throw new Error('前 50 行中未找到至少包含 2 个字段的表头。');
  }
  return scored[0];
}

export function buildSchemaMapping(masterEntries, sourceEntries) {
  const outputEntries = masterEntries.map((entry, index) => ({
    ...entry,
    outputColumn: entry.outputColumn ?? index + 1,
  }));
  const originalCount = outputEntries.length;
  const keyToColumn = new Map(outputEntries.map((entry) => [entry.key, entry.outputColumn]));
  const sourceToOutput = new Map();
  const addedEntries = [];
  let matchedNamedCount = 0;

  for (const sourceEntry of sourceEntries) {
    let outputColumn = keyToColumn.get(sourceEntry.key);
    if (outputColumn === undefined) {
      outputColumn = outputEntries.length + 1;
      const added = { ...sourceEntry, outputColumn };
      outputEntries.push(added);
      addedEntries.push(added);
      keyToColumn.set(sourceEntry.key, outputColumn);
    } else if (!sourceEntry.isBlank) {
      matchedNamedCount += 1;
    }
    sourceToOutput.set(sourceEntry.sourceColumn, outputColumn);
  }

  const referenceNamedCount = masterEntries.filter((entry) => !entry.isBlank).length;
  const sourceNamedCount = sourceEntries.filter((entry) => !entry.isBlank).length;
  const denominator = Math.min(referenceNamedCount, sourceNamedCount);
  const similarity = denominator > 0 ? matchedNamedCount / denominator : 0;
  const identical =
    originalCount === sourceEntries.length &&
    sourceEntries.every((entry, index) => outputEntries[index]?.key === entry.key);
  const missingNamedCount = Math.max(0, referenceNamedCount - matchedNamedCount);

  let kind = 'partial';
  if (identical) kind = 'identical';
  else if (!addedEntries.length && missingNamedCount === 0) kind = 'reordered';
  else if (addedEntries.length) kind = 'expanded';

  return {
    outputEntries,
    sourceToOutput,
    addedEntries,
    matchedNamedCount,
    referenceNamedCount,
    sourceNamedCount,
    missingNamedCount,
    similarity,
    identical,
    kind,
  };
}

export function isReliableAlignment(mapping) {
  return mapping.referenceNamedCount >= 2 &&
    mapping.sourceNamedCount >= 2 &&
    mapping.similarity >= MIN_HEADER_SIMILARITY;
}

export function formatTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function buildOutputFilename(firstFilename, date = new Date()) {
  const safeName = String(firstFilename || 'merged.xlsx').split(/[\\/]/).pop() || 'merged.xlsx';
  const withExtension = /\.xlsx$/i.test(safeName) ? safeName : `${safeName}.xlsx`;
  return `${formatTimestamp(date)}_${withExtension}`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** power);
  return `${value.toFixed(power === 0 || value >= 10 ? 0 : 1)} ${units[power]}`;
}
