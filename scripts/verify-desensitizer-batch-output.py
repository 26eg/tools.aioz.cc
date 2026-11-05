"""Independent batch verification using the existing openpyxl/OOXML verifier. Python 3.11+."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True


def main() -> None:
    root = Path(sys.argv[1]).resolve()
    summary = json.loads((root / '多文件验证结果.json').read_text(encoding='utf-8'))
    spec = importlib.util.spec_from_file_location('independent_verifier', Path(__file__).with_name('verify-desensitizer-output.py'))
    if spec is None or spec.loader is None:
        raise RuntimeError('Independent verifier unavailable')
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    results = []
    for index, item in enumerate(summary['files'], start=1):
        directory = root / f'独立核验-{index}'
        directory.mkdir(exist_ok=True)
        record = {'source': item['source'], 'sourceSha256': hashlib.sha256(Path(item['source']).read_bytes()).hexdigest(), 'stats': summary['stats'], 'files': {
            'workbook': str(root / item['masked']), 'restored': str(root / item['restored']),
            'dictionary': str(root / summary['dictionary']),
        }}
        (directory / '验证结果.json').write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
        sys.argv = [sys.argv[0], str(directory)]
        verifier.main()
        results.append(json.loads((directory / '独立校验.json').read_text(encoding='utf-8')))
    (root / '多文件独立校验.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
