"""Read-only independent OOXML/openpyxl verification; Python 3.11+ and openpyxl."""
from __future__ import annotations

import hashlib
import json
import re
import sys
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from zipfile import ZipFile
import xml.etree.ElementTree as ET

from openpyxl import load_workbook


def main() -> None:
    directory = Path(sys.argv[1]).resolve()
    summary = json.loads((directory / "验证结果.json").read_text())
    source_path = Path(summary["source"])
    source = load_workbook(source_path, read_only=False, data_only=False)
    masked = load_workbook(directory / summary["files"]["workbook"], read_only=False, data_only=False)
    recovered = load_workbook(directory / summary["files"]["restored"], read_only=False, data_only=False)
    dictionary = load_workbook(directory / summary["files"]["dictionary"], read_only=True, data_only=False)
    column_modes = summary.get('columnModes', {})
    mapping = {row[2]: row[1] for row in dictionary["映射字典"].iter_rows(min_row=2, values_only=True)}
    assert len(mapping) == summary["stats"]["unique"]
    checked = numbers = dates = blanks = names = 0
    for original_sheet, masked_sheet, restored_sheet in zip(source.worksheets, masked.worksheets, recovered.worksheets, strict=True):
        assert original_sheet.title == restored_sheet.title
        assert (original_sheet.max_row, original_sheet.max_column) == (masked_sheet.max_row, masked_sheet.max_column)
        for original_row in original_sheet:
            for cell in original_row:
                anonymized, restored = masked_sheet[cell.coordinate], restored_sheet[cell.coordinate]
                checked += 1
                if cell.row == 1:
                    assert restored.value == cell.value
                    continue
                if cell.value is None or isinstance(cell.value, str) and re.fullmatch(r"[\s\u200b-\u200d\u2060\ufeff]*", cell.value):
                    assert anonymized.value is None and restored.value is None
                    blanks += 1
                elif isinstance(cell.value, (int, float)) and not isinstance(cell.value, bool):
                    expected = float(Decimal(str(cell.value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
                    assert anonymized.value == expected and restored.value == expected, cell.coordinate
                    numbers += 1
                elif isinstance(cell.value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", cell.value) and int(cell.value[:4]) >= max(1900, source.epoch.year) and (not column_modes or column_modes.get(original_sheet.title, {}).get(cell.column_letter) == "date"):
                    expected = datetime.strptime(cell.value, "%Y-%m-%d")
                    assert anonymized.value == expected and restored.value == expected, cell.coordinate
                    assert anonymized.is_date and restored.is_date
                    dates += 1
                elif anonymized.value in mapping:
                    assert mapping[anonymized.value] == cell.value == restored.value, cell.coordinate
                    names += 1
                else:
                    expected = float(cell.value) if isinstance(restored.value, (int, float)) else cell.value
                    assert restored.value == expected, cell.coordinate
        # Preserve structural formatting independent of the application reader.
        for letter, dimension in original_sheet.column_dimensions.items():
            assert dimension.width == masked_sheet.column_dimensions[letter].width
            assert dimension.hidden == masked_sheet.column_dimensions[letter].hidden
        for row, dimension in original_sheet.row_dimensions.items():
            assert dimension.height == masked_sheet.row_dimensions[row].height
        assert original_sheet.freeze_panes == masked_sheet.freeze_panes
        assert original_sheet.auto_filter.ref == masked_sheet.auto_filter.ref
    assert hashlib.sha256(source_path.read_bytes()).hexdigest() == summary["sourceSha256"]
    with ZipFile(directory / summary["files"]["workbook"]) as archive:
        assert archive.testzip() is None
        assert "xl/sharedStrings.xml" not in archive.namelist()
        assert "docProps/core.xml" not in archive.namelist()
        for name in archive.namelist():
            if name.endswith(".xml") or name.endswith(".rels"):
                ET.fromstring(archive.read(name))
    result = {"reader": "openpyxl + ElementTree + Decimal", "cells_checked": checked, "numeric_cells": numbers, "typed_dates": dates, "true_blanks": blanks, "restored_names": names, "structure_preserved": True, "source_unchanged": True}
    (directory / "独立校验.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
