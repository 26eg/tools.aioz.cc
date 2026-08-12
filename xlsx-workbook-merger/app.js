import {
  MAX_HEADER_SCAN_ROWS,
  MAX_SUPPORTED_COLUMNS,
  appendUniqueXlsxFiles,
  buildOutputFilename,
  buildSchemaMapping,
  formatBytes,
  isReliableAlignment,
  selectHeaderCandidate,
} from './core.js?v=20260811-3';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const YIELD_EVERY_ROWS = 80;

const elements = {
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('fileInput'),
  selectedPanel: document.getElementById('selectedPanel'),
  fileSummary: document.getElementById('fileSummary'),
  fileList: document.getElementById('fileList'),
  mergeButton: document.getElementById('mergeButton'),
  clearButton: document.getElementById('clearButton'),
  formError: document.getElementById('formError'),
  progressPanel: document.getElementById('progressPanel'),
  progressBar: document.getElementById('progressBar'),
  statusBox: document.getElementById('statusBox'),
  statusTitle: document.getElementById('statusTitle'),
  statusDetail: document.getElementById('statusDetail'),
  resultPanel: document.getElementById('resultPanel'),
  resultSummary: document.getElementById('resultSummary'),
  reportBody: document.getElementById('reportBody'),
  downloadLink: document.getElementById('downloadLink'),
  resultNote: document.getElementById('resultNote'),
};

const state = {
  files: [],
  processing: false,
  outputUrl: null,
};

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function revokeOutput() {
  if (state.outputUrl) URL.revokeObjectURL(state.outputUrl);
  state.outputUrl = null;
}

function resetResult() {
  revokeOutput();
  elements.progressPanel.classList.add('hidden');
  elements.resultPanel.classList.add('hidden');
  elements.reportBody.replaceChildren();
  elements.progressBar.style.width = '0%';
  elements.statusBox.className = 'status';
  elements.statusTitle.textContent = '准备处理…';
  elements.statusDetail.textContent = '';
  elements.resultSummary.textContent = '';
  elements.resultNote.textContent = '';
  elements.downloadLink.href = '#';
  elements.downloadLink.textContent = '下载合并后的工作簿';
  window.__xlsxWorkbookMergerLastResult = null;
}

function addFiles(fileList) {
  if (state.processing) return;
  const selection = appendUniqueXlsxFiles(state.files, Array.from(fileList));
  state.files = selection.files;
  if (selection.addedCount) resetResult();
  renderFileList();
  const notices = [];
  if (selection.invalidCount) notices.push(`已忽略 ${selection.invalidCount} 个非 .xlsx 文件。`);
  if (selection.duplicateCount) notices.push(`已忽略 ${selection.duplicateCount} 个重复文件。`);
  elements.formError.textContent = notices.join(' ');
}

function clearBatch() {
  if (state.processing) return;
  state.files = [];
  elements.fileInput.value = '';
  elements.formError.textContent = '';
  resetResult();
  renderFileList();
  elements.fileInput.focus({ preventScroll: true });
}

function moveFile(index, offset) {
  if (state.processing) return;
  const target = index + offset;
  if (target < 0 || target >= state.files.length) return;
  [state.files[index], state.files[target]] = [state.files[target], state.files[index]];
  resetResult();
  renderFileList();
}

function removeFile(index) {
  if (state.processing) return;
  state.files.splice(index, 1);
  resetResult();
  renderFileList();
}

function renderFileList() {
  elements.fileList.replaceChildren();
  const totalBytes = state.files.reduce((sum, file) => sum + file.size, 0);
  elements.selectedPanel.classList.toggle('hidden', state.files.length === 0);
  elements.fileSummary.textContent = `${state.files.length} 个文件 · ${formatBytes(totalBytes)}`;
  elements.mergeButton.disabled = state.processing || state.files.length < 2;
  elements.clearButton.disabled = state.processing || state.files.length === 0;
  elements.fileInput.disabled = state.processing;
  elements.dropzone.classList.toggle('disabled', state.processing);

  state.files.forEach((file, index) => {
    const item = document.createElement('li');
    item.className = 'file-item';

    const number = document.createElement('span');
    number.className = 'file-index';
    number.textContent = String(index + 1);

    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'file-name';
    name.title = file.name;
    name.append(document.createTextNode(file.name));
    if (index === 0) {
      const badge = document.createElement('span');
      badge.className = 'base-badge';
      badge.textContent = '基准 / 输出名';
      name.append(badge);
    }
    const meta = document.createElement('div');
    meta.className = 'file-meta';
    meta.textContent = formatBytes(file.size);
    info.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 'file-actions';
    const buttonSpecs = [
      ['up', '上移', index === 0],
      ['down', '下移', index === state.files.length - 1],
      ['remove', '移除', false],
    ];
    for (const [action, label, boundaryDisabled] of buttonSpecs) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'icon-btn';
      button.dataset.action = action;
      button.dataset.index = String(index);
      button.textContent = label;
      button.disabled = state.processing || boundaryDisabled;
      actions.append(button);
    }

    item.append(number, info, actions);
    elements.fileList.append(item);
  });
}

function setProgress(percent, title, detail = '', type = 'info') {
  elements.progressPanel.classList.remove('hidden');
  elements.progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  elements.statusTitle.textContent = title;
  elements.statusDetail.textContent = detail;
  elements.statusBox.className = `status ${type === 'info' ? '' : type}`.trim();
}

function rowValues(worksheet, rowNumber, columnCount) {
  const row = worksheet.getRow(rowNumber);
  return Array.from({ length: columnCount }, (_, index) => row.getCell(index + 1).value);
}

function detectHeader(worksheet, referenceEntries = []) {
  if (worksheet.columnCount > MAX_SUPPORTED_COLUMNS) {
    throw new Error(`检测到 ${worksheet.columnCount} 列，超过当前安全上限 ${MAX_SUPPORTED_COLUMNS} 列。`);
  }
  const columnCount = Math.max(worksheet.columnCount, 1);
  const scanRows = Math.min(worksheet.rowCount, MAX_HEADER_SCAN_ROWS);
  const candidates = [];
  for (let rowNumber = 1; rowNumber <= scanRows; rowNumber += 1) {
    candidates.push({ rowNumber, values: rowValues(worksheet, rowNumber, columnCount) });
  }
  return selectHeaderCandidate(candidates, referenceEntries);
}

function hasValue(value) {
  return value !== null && value !== undefined;
}

function findLastDataRow(worksheet, headerRow, entries) {
  for (let rowNumber = worksheet.rowCount; rowNumber > headerRow; rowNumber -= 1) {
    const row = worksheet.getRow(rowNumber);
    if (entries.some((entry) => hasValue(row.getCell(entry.sourceColumn).value))) return rowNumber;
  }
  return headerRow;
}

function featureCounts(worksheet) {
  const tables = worksheet.model?.tables?.length ??
    (worksheet._tables ? Object.keys(worksheet._tables).length : 0);
  const conditionalFormats = worksheet.conditionalFormattings?.length ?? 0;
  const images = typeof worksheet.getImages === 'function' ? worksheet.getImages().length : 0;
  return { tables, conditionalFormats, images };
}

function canonicalValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalValue);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) result[key] = canonicalValue(value[key]);
  }
  return result;
}

function incrementHistogram(histogram, key) {
  histogram.set(key, (histogram.get(key) ?? 0) + 1);
}

function sameHistogram(expected, actual) {
  if (expected.size !== actual.size) return false;
  for (const [key, count] of expected) {
    if (actual.get(key) !== count) return false;
  }
  return true;
}

function collectWorksheetMetrics(worksheet, lastRow, columnCount) {
  const styleFingerprintCache = new WeakMap();
  const metrics = {
    hyperlinks: 0,
    formulas: 0,
    styledCells: 0,
    customRowHeights: 0,
    styleHistogram: new Map(),
    rowHeightHistogram: new Map(),
    columns: [],
  };
  for (let rowNumber = 1; rowNumber <= lastRow; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    if (row.height !== undefined) {
      metrics.customRowHeights += 1;
      incrementHistogram(metrics.rowHeightHistogram, String(row.height));
    }
    for (let column = 1; column <= columnCount; column += 1) {
      const cell = row.getCell(column);
      if (cell.hasStyle) {
        metrics.styledCells += 1;
        let fingerprint = styleFingerprintCache.get(cell.style);
        if (!fingerprint) {
          fingerprint = JSON.stringify(canonicalValue(cell.style));
          styleFingerprintCache.set(cell.style, fingerprint);
        }
        incrementHistogram(metrics.styleHistogram, fingerprint);
      }
      const value = cell.value;
      if (!value || typeof value !== 'object') continue;
      if (value.hyperlink !== undefined) metrics.hyperlinks += 1;
      if (value.formula !== undefined || value.sharedFormula !== undefined) metrics.formulas += 1;
    }
  }
  for (let column = 1; column <= columnCount; column += 1) {
    const source = worksheet.getColumn(column);
    metrics.columns.push({
      width: source.width ?? null,
      hidden: Boolean(source.hidden),
      outlineLevel: source.outlineLevel ?? 0,
    });
  }
  return metrics;
}

function sameColumnLayout(expected, actual) {
  if (expected.length !== actual.length) return false;
  return expected.every((column, index) => {
    const other = actual[index];
    const widthMatches = column.width === null
      ? other.width === null
      : other.width !== null && Math.abs(column.width - other.width) < 0.01;
    return widthMatches && column.hidden === other.hidden && column.outlineLevel === other.outlineLevel;
  });
}

async function verifyGeneratedWorkbook(buffer, expected) {
  const verificationWorkbook = new window.ExcelJS.Workbook();
  try {
    await verificationWorkbook.xlsx.load(buffer);
  } catch (error) {
    throw new Error(`输出文件生成后无法重新读取：${error?.message || 'XLSX 包结构无效。'}`);
  }
  if (verificationWorkbook.worksheets.length !== 1) {
    throw new Error(`输出校验失败：预期 1 个工作表，实际为 ${verificationWorkbook.worksheets.length} 个。`);
  }
  const worksheet = verificationWorkbook.worksheets[0];
  const header = detectHeader(worksheet, expected.headerEntries);
  const actualHeaderKeys = header.entries.map((entry) => entry.key);
  const expectedHeaderKeys = expected.headerEntries.map((entry) => entry.key);
  if (header.rowNumber !== expected.headerRow ||
      actualHeaderKeys.length !== expectedHeaderKeys.length ||
      actualHeaderKeys.some((key, index) => key !== expectedHeaderKeys[index])) {
    throw new Error('输出校验失败：重新读取后的表头字段或顺序与预期不一致。');
  }
  const lastDataRow = findLastDataRow(worksheet, header.rowNumber, header.entries);
  if (lastDataRow !== expected.lastRow) {
    throw new Error(`输出校验失败：预期最后一行为 ${expected.lastRow}，实际为 ${lastDataRow}。`);
  }
  const metrics = collectWorksheetMetrics(worksheet, lastDataRow, expectedHeaderKeys.length);
  if (metrics.hyperlinks !== expected.metrics.hyperlinks) {
    throw new Error(`输出校验失败：超链接数量应为 ${expected.metrics.hyperlinks}，实际为 ${metrics.hyperlinks}。`);
  }
  if (metrics.formulas !== expected.metrics.formulas) {
    throw new Error(`输出校验失败：公式数量应为 ${expected.metrics.formulas}，实际为 ${metrics.formulas}。`);
  }
  if (metrics.customRowHeights !== expected.metrics.customRowHeights) {
    throw new Error(
      `输出校验失败：自定义行高数量应为 ${expected.metrics.customRowHeights}，实际为 ${metrics.customRowHeights}。`,
    );
  }
  if (metrics.styledCells < expected.metrics.styledCells) {
    throw new Error(
      `输出校验失败：带样式单元格由 ${expected.metrics.styledCells} 减少为 ${metrics.styledCells}。`,
    );
  }
  if (!sameHistogram(expected.metrics.styleHistogram, metrics.styleHistogram)) {
    throw new Error('输出校验失败：重新读取后的单元格样式组合或分布与生成前不一致。');
  }
  if (!sameHistogram(expected.metrics.rowHeightHistogram, metrics.rowHeightHistogram)) {
    throw new Error('输出校验失败：重新读取后的自定义行高分布与生成前不一致。');
  }
  if (!sameColumnLayout(expected.metrics.columns, metrics.columns)) {
    throw new Error('输出校验失败：重新读取后的列宽、隐藏列或分级设置与预期不一致。');
  }
  return { worksheet, header, lastDataRow, metrics };
}

function assertSupportedWorksheet(worksheet, filename, { allowImages = false } = {}) {
  const features = featureCounts(worksheet);
  const unsupported = [];
  if (features.tables) unsupported.push(`${features.tables} 个表格对象`);
  if (features.conditionalFormats) unsupported.push(`${features.conditionalFormats} 组条件格式`);
  if (!allowImages && features.images) unsupported.push(`${features.images} 张图片`);
  if (unsupported.length) {
    throw new Error(`${filename} 的第一个工作表包含 ${unsupported.join('、')}，为避免格式或对象丢失，已停止合并。`);
  }
}

async function loadWorkbook(file) {
  if (!window.ExcelJS?.Workbook) {
    throw new Error('Excel 处理组件加载失败，请检查网络后刷新页面重试。');
  }
  const workbook = new window.ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(await file.arrayBuffer());
  } catch (error) {
    throw new Error(`${file.name} 无法读取：${error?.message || '文件可能损坏、加密或不是有效的 XLSX。'}`);
  }
  if (!workbook.worksheets.length) throw new Error(`${file.name} 中没有工作表。`);
  return workbook;
}

function deepClone(value, seen = new WeakMap()) {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) return new value.constructor(value);
  if (seen.has(value)) return seen.get(value);
  const clone = Array.isArray(value) ? [] : {};
  seen.set(value, clone);
  for (const [key, child] of Object.entries(value)) clone[key] = deepClone(child, seen);
  return clone;
}

function createStyleCloner() {
  const cache = new WeakMap();
  return (style) => {
    if (!style || typeof style !== 'object') return style;
    if (cache.has(style)) return cache.get(style);
    const cloned = deepClone(style);
    cache.set(style, cloned);
    return cloned;
  };
}

function copyCell(sourceCell, targetCell, cloneStyle) {
  targetCell.value = deepClone(sourceCell.value);
  if (sourceCell.hasStyle) targetCell.style = cloneStyle(sourceCell.style);
  if (sourceCell.note !== undefined && sourceCell.note !== null) targetCell.note = deepClone(sourceCell.note);
  if (sourceCell.dataValidation && Object.keys(sourceCell.dataValidation).length) {
    targetCell.dataValidation = deepClone(sourceCell.dataValidation);
  }
}

function copyNewColumns(sourceWorksheet, outputWorksheet, sourceHeader, outputHeaderRow, mapping) {
  if (!mapping.addedEntries.length) return;
  const cloneStyle = createStyleCloner();
  for (const added of mapping.addedEntries) {
    const sourceColumn = sourceWorksheet.getColumn(added.sourceColumn);
    const outputColumn = outputWorksheet.getColumn(added.outputColumn);
    if (sourceColumn.width !== undefined) outputColumn.width = sourceColumn.width;
    outputColumn.hidden = Boolean(sourceColumn.hidden);
    if (sourceColumn.outlineLevel !== undefined) outputColumn.outlineLevel = sourceColumn.outlineLevel;
    if (sourceColumn.style && Object.keys(sourceColumn.style).length) {
      outputColumn.style = cloneStyle(sourceColumn.style);
    }
    copyCell(
      sourceWorksheet.getRow(sourceHeader.rowNumber).getCell(added.sourceColumn),
      outputWorksheet.getRow(outputHeaderRow).getCell(added.outputColumn),
      cloneStyle,
    );
  }
}

async function copyDataRows({
  sourceWorksheet,
  outputWorksheet,
  header,
  lastDataRow,
  sourceToOutput,
  outputStartRow,
  onProgress,
}) {
  const cloneStyle = createStyleCloner();
  const dataStartRow = header.rowNumber + 1;
  const rowCount = Math.max(0, lastDataRow - header.rowNumber);

  for (let offset = 0; offset < rowCount; offset += 1) {
    const sourceRow = sourceWorksheet.getRow(dataStartRow + offset);
    const targetRow = outputWorksheet.getRow(outputStartRow + offset);
    if (sourceRow.height !== undefined) targetRow.height = sourceRow.height;
    targetRow.hidden = Boolean(sourceRow.hidden);
    if (sourceRow.outlineLevel !== undefined) targetRow.outlineLevel = sourceRow.outlineLevel;

    for (const entry of header.entries) {
      const outputColumn = sourceToOutput.get(entry.sourceColumn);
      if (outputColumn === undefined) continue;
      copyCell(
        sourceRow.getCell(entry.sourceColumn),
        targetRow.getCell(outputColumn),
        cloneStyle,
      );
    }

    if ((offset + 1) % YIELD_EVERY_ROWS === 0) {
      onProgress?.(offset + 1, rowCount);
      await nextFrame();
    }
  }
  onProgress?.(rowCount, rowCount);
}

function columnLettersToNumber(letters) {
  let result = 0;
  for (const letter of letters.toUpperCase()) result = result * 26 + letter.charCodeAt(0) - 64;
  return result;
}

function columnNumberToLetters(column) {
  let value = column;
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function parseMergeRange(range) {
  const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(range);
  if (!match) return null;
  return {
    startColumn: columnLettersToNumber(match[1]),
    startRow: Number(match[2]),
    endColumn: columnLettersToNumber(match[3]),
    endRow: Number(match[4]),
  };
}

function copyMergedRanges({
  sourceWorksheet,
  outputWorksheet,
  headerRow,
  lastDataRow,
  sourceToOutput,
  outputStartRow,
}) {
  let copied = 0;
  let skipped = 0;
  const dataStartRow = headerRow + 1;
  for (const rawRange of sourceWorksheet.model?.merges ?? []) {
    const range = parseMergeRange(rawRange);
    if (!range || range.startRow < dataStartRow || range.endRow > lastDataRow) {
      skipped += 1;
      continue;
    }
    const mappedColumns = [];
    for (let column = range.startColumn; column <= range.endColumn; column += 1) {
      mappedColumns.push(sourceToOutput.get(column));
    }
    const contiguous = mappedColumns.every((column, index) =>
      Number.isInteger(column) && (index === 0 || column === mappedColumns[index - 1] + 1));
    if (!contiguous) {
      skipped += 1;
      continue;
    }
    const targetStartRow = outputStartRow + (range.startRow - dataStartRow);
    const targetEndRow = outputStartRow + (range.endRow - dataStartRow);
    outputWorksheet.mergeCells(
      `${columnNumberToLetters(mappedColumns[0])}${targetStartRow}:` +
      `${columnNumberToLetters(mappedColumns.at(-1))}${targetEndRow}`,
    );
    copied += 1;
  }
  return { copied, skipped };
}

function alignmentLabel(mapping, isBase = false) {
  if (isBase) return '基准表头';
  if (mapping.kind === 'identical') return '字段与顺序一致';
  if (mapping.kind === 'reordered') return '已按表头重排';
  if (mapping.kind === 'expanded') return `已对齐，新增 ${mapping.addedEntries.length} 列`;
  return `已对齐，缺少 ${mapping.missingNamedCount} 列`;
}

function appendReportRow(report, index) {
  const row = document.createElement('tr');
  const values = [
    index + 1,
    report.filename,
    report.worksheet,
    report.headerRow,
    report.dataRows.toLocaleString('zh-CN'),
    report.alignment,
  ];
  values.forEach((value, valueIndex) => {
    const cell = document.createElement('td');
    cell.textContent = String(value);
    if (valueIndex === 1) cell.title = report.filename;
    row.append(cell);
  });
  elements.reportBody.append(row);
}

async function mergeSelectedFiles() {
  if (state.processing || state.files.length < 2) {
    elements.formError.textContent = '请至少选择 2 个 XLSX 文件。';
    return;
  }

  state.processing = true;
  elements.formError.textContent = '';
  resetResult();
  renderFileList();
  elements.resultPanel.classList.add('hidden');
  const files = [...state.files];
  const reports = [];
  let ignoredSheets = 0;
  let totalDataRows = 0;
  let skippedMerges = 0;

  try {
    setProgress(2, '正在读取基准文件…', files[0].name);
    const outputWorkbook = await loadWorkbook(files[0]);
    const outputWorksheet = outputWorkbook.worksheets[0];
    assertSupportedWorksheet(outputWorksheet, files[0].name, { allowImages: true });
    const baseHeader = detectHeader(outputWorksheet);
    const baseLastDataRow = findLastDataRow(outputWorksheet, baseHeader.rowNumber, baseHeader.entries);
    const baseDataRows = Math.max(0, baseLastDataRow - baseHeader.rowNumber);
    let masterEntries = baseHeader.entries.map((entry, index) => ({ ...entry, outputColumn: index + 1 }));
    let outputRowCursor = baseLastDataRow;
    totalDataRows += baseDataRows;
    ignoredSheets += Math.max(0, outputWorkbook.worksheets.length - 1);
    for (const worksheet of outputWorkbook.worksheets.slice(1)) outputWorkbook.removeWorksheet(worksheet.id);

    reports.push({
      filename: files[0].name,
      worksheet: outputWorksheet.name,
      headerRow: baseHeader.rowNumber,
      dataRows: baseDataRows,
      alignment: alignmentLabel(null, true),
    });

    for (let fileIndex = 1; fileIndex < files.length; fileIndex += 1) {
      const file = files[fileIndex];
      const fileBaseProgress = 8 + (fileIndex / files.length) * 72;
      setProgress(fileBaseProgress, `正在分析第 ${fileIndex + 1}/${files.length} 个文件…`, file.name);
      let sourceWorkbook = await loadWorkbook(file);
      const sourceWorksheet = sourceWorkbook.worksheets[0];
      ignoredSheets += Math.max(0, sourceWorkbook.worksheets.length - 1);
      assertSupportedWorksheet(sourceWorksheet, file.name);

      const header = detectHeader(sourceWorksheet, masterEntries);
      const mapping = buildSchemaMapping(masterEntries, header.entries);
      if (!isReliableAlignment(mapping)) {
        const percent = Math.round(mapping.similarity * 100);
        throw new Error(
          `${file.name} 只匹配到 ${mapping.matchedNamedCount}/${mapping.sourceNamedCount} 个表头字段（${percent}%），` +
          '无法可靠对齐。请确认该文件的第一个工作表与其他文件属于同一数据集。',
        );
      }

      copyNewColumns(sourceWorksheet, outputWorksheet, header, baseHeader.rowNumber, mapping);
      masterEntries = mapping.outputEntries;
      const lastDataRow = findLastDataRow(sourceWorksheet, header.rowNumber, header.entries);
      const dataRows = Math.max(0, lastDataRow - header.rowNumber);
      const outputStartRow = outputRowCursor + 1;
      await copyDataRows({
        sourceWorksheet,
        outputWorksheet,
        header,
        lastDataRow,
        sourceToOutput: mapping.sourceToOutput,
        outputStartRow,
        onProgress: (completed, total) => {
          const withinFile = total > 0 ? completed / total : 1;
          const progress = 8 + ((fileIndex + withinFile) / files.length) * 72;
          setProgress(
            progress,
            `正在合并第 ${fileIndex + 1}/${files.length} 个文件…`,
            `${file.name}\n已处理 ${completed.toLocaleString('zh-CN')} / ${total.toLocaleString('zh-CN')} 行`,
          );
        },
      });
      const mergeResult = copyMergedRanges({
        sourceWorksheet,
        outputWorksheet,
        headerRow: header.rowNumber,
        lastDataRow,
        sourceToOutput: mapping.sourceToOutput,
        outputStartRow,
      });

      outputRowCursor += dataRows;
      totalDataRows += dataRows;
      skippedMerges += mergeResult.skipped;
      reports.push({
        filename: file.name,
        worksheet: sourceWorksheet.name,
        headerRow: header.rowNumber,
        dataRows,
        alignment: alignmentLabel(mapping),
      });
      sourceWorkbook = null;
      await nextFrame();
    }

    const expectedMetrics = collectWorksheetMetrics(outputWorksheet, outputRowCursor, masterEntries.length);
    setProgress(84, '正在生成 XLSX 文件…', '数据已合并，正在写入工作簿。较大的文件可能需要一些时间。');
    await nextFrame();
    const outputBuffer = await outputWorkbook.xlsx.writeBuffer();
    setProgress(93, '正在校验输出文件…', '重新读取最终 XLSX，核对行列、表头、超链接和格式结构。');
    await nextFrame();
    const verification = await verifyGeneratedWorkbook(outputBuffer, {
      headerEntries: masterEntries,
      headerRow: baseHeader.rowNumber,
      lastRow: outputRowCursor,
      metrics: expectedMetrics,
    });
    const outputBlob = new Blob([outputBuffer], { type: XLSX_MIME });
    const outputFilename = buildOutputFilename(files[0].name);
    state.outputUrl = URL.createObjectURL(outputBlob);
    elements.downloadLink.href = state.outputUrl;
    elements.downloadLink.download = outputFilename;
    elements.downloadLink.textContent = `下载 ${outputFilename}`;

    elements.reportBody.replaceChildren();
    reports.forEach(appendReportRow);
    elements.resultSummary.textContent =
      `已将 ${files.length} 个文件合并为 1 个工作表，共 ${totalDataRows.toLocaleString('zh-CN')} 条数据、` +
      `${masterEntries.length.toLocaleString('zh-CN')} 列；忽略 ${ignoredSheets} 个非首工作表。`;
    const notes = ['最终文件已重新读取校验', `输出约 ${formatBytes(outputBlob.size)}`];
    if (verification.metrics.hyperlinks) {
      notes.push(`包含 ${verification.metrics.hyperlinks.toLocaleString('zh-CN')} 个超链接`);
    }
    if (verification.metrics.formulas) notes.push(`包含 ${verification.metrics.formulas.toLocaleString('zh-CN')} 个公式`);
    if (skippedMerges) notes.push(`${skippedMerges} 个无法映射的合并区域未迁移`);
    elements.resultNote.textContent = notes.join(' · ');
    elements.resultPanel.classList.remove('hidden');
    setProgress(100, '合并完成', '工作簿已在浏览器本地生成，可点击下方按钮下载。', 'success');
    window.__xlsxWorkbookMergerLastResult = {
      filename: outputFilename,
      fileCount: files.length,
      dataRows: totalDataRows,
      columns: masterEntries.length,
      outputRows: outputRowCursor,
      ignoredSheets,
    };
  } catch (error) {
    console.error('工作簿合并失败：', error);
    revokeOutput();
    elements.resultPanel.classList.add('hidden');
    setProgress(100, '合并失败', error?.message || '发生未知错误，请重新选择文件后再试。', 'error');
  } finally {
    state.processing = false;
    renderFileList();
  }
}

elements.fileInput.addEventListener('change', () => {
  addFiles(elements.fileInput.files);
  elements.fileInput.value = '';
});
elements.fileList.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const index = Number(button.dataset.index);
  if (button.dataset.action === 'up') moveFile(index, -1);
  if (button.dataset.action === 'down') moveFile(index, 1);
  if (button.dataset.action === 'remove') removeFile(index);
});
elements.mergeButton.addEventListener('click', mergeSelectedFiles);
elements.clearButton.addEventListener('click', clearBatch);

for (const eventName of ['dragenter', 'dragover']) {
  elements.dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    if (!state.processing) elements.dropzone.classList.add('dragover');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  elements.dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropzone.classList.remove('dragover');
  });
}
elements.dropzone.addEventListener('drop', (event) => {
  if (!state.processing) addFiles(event.dataTransfer.files);
});
window.addEventListener('beforeunload', revokeOutput);

renderFileList();
