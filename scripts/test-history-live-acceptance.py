"""Synthetic acceptance/rejection and redaction checks; no provider access."""
import contextlib
import copy
import datetime as dt
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('checker', Path(__file__).with_name('check-history-live-acceptance.py'))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


def fixture():
    """Build a deterministic full-count acceptance envelope."""
    dates = [(dt.date(2023, 6, 30) - dt.timedelta(days=i)).isoformat() for i in reversed(range(180))]
    entries = []
    for d in dates:
        for code in c.CODES + ['090']:
            m = {'baseDate': d, 'requestedBaseDate': d, 'kind': {'code': code, 'name': (c.NAMES[c.CODES.index(code)] if code in c.CODES else 'synthetic')},
                 'dateResolution': {'mode': 'exact', 'requestedBaseDate': d, 'resolvedBaseDate': d, 'usedFallback': False, 'attemptedDates': [d], 'lookbackDays': 0},
                 'source': c.source(d, code), 'tenors': c.TENORS,
                 'rows': [{'pricingGroupCode': 'synthetic', 'pricingGroupName': 'synthetic', 'yields': {t: (0 if t == '3M' else None) for t in c.TENORS}}]}
            entries.append({'availability': 'available', 'matrix': m})
    return {'ok': True, 'operation': 'history', 'result': {'requestedDates': dates,
        'countSelection': {'count': 180, 'endDate': c.END, 'scannedStartDate': dates[0], 'scannedDateCount': 180},
        'discovery': [{'requestedBaseDate': d, 'available': True} for d in dates],
        'entries': entries, 'mode': 'exact', 'lookbackDays': 0, 'availableCount': 1620, 'unavailableCount': 0, 'dataRowCount': 1620}}


def write_provenance(path, binary, version='ytm synthetic'):
    """Write test provenance that is bound to the candidate binary digest."""
    path.write_text(json.dumps({
        'sourceCommit': 'a' * 40,
        'binarySha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
        'version': version,
    }))


class CheckerTests(unittest.TestCase):
    def setUp(self):
        """Reset the fixture before each independent validation case."""
        self.f = fixture()

    def check(self, f, expected, exit_code=0):
        """Assert acceptance and verify that no provider text is printed."""
        capture = io.StringIO()
        with contextlib.redirect_stdout(capture), contextlib.redirect_stderr(capture):
            report = c.assess(json.dumps(f), exit_code)
        self.assertEqual(report['accepted'], expected)
        self.assertEqual(capture.getvalue(), '')
        return report

    def test_success_and_unavailable(self):
        """Accept valid full histories and ordinary unavailable pairs."""
        self.check(self.f, True)
        r = self.f['result']
        m = r['entries'][0]['matrix']
        r['entries'][0] = {'availability': 'unavailable', 'requestedBaseDate': m['baseDate'], 'kind': m['kind'], 'mode': 'exact', 'lookbackDays': 0, 'attemptedDates': [m['baseDate']], 'stage': 'matrix', 'reason': 'source_data_unavailable: matrix returned no rows'}
        r['availableCount'] -= 1
        r['unavailableCount'] += 1
        r['dataRowCount'] -= 1
        self.check(self.f, True)
        r['entries'][1]['matrix']['rows'][0]['yields']['3M'] = -0.5
        self.check(self.f, True)

    def test_selection_rejections(self):
        """Reject malformed date selection and scan metadata."""
        for mode in ['short', 'duplicate', 'order', 'future', 'scan', 'discovery']:
            f = copy.deepcopy(self.f)
            r = f['result']
            if mode == 'short': r['requestedDates'].pop()
            if mode == 'duplicate': r['requestedDates'][1] = r['requestedDates'][0]
            if mode == 'order': r['requestedDates'].reverse()
            if mode == 'future': r['requestedDates'][-1] = '2023-07-01'
            if mode == 'scan': r['countSelection']['scannedDateCount'] -= 1
            if mode == 'discovery': r['discovery'].pop()
            with self.subTest(mode=mode): self.check(f, False)

    def test_category_and_source_rejections(self):
        """Reject category, provenance, fallback, and counter drift."""
        for mode in ['missing', 'duplicate', 'order', 'source', 'fallback', 'counter', 'name', 'suppressedError']:
            f = copy.deepcopy(self.f)
            r = f['result']
            if mode == 'missing': r['entries'].pop(0)
            if mode == 'duplicate': r['entries'][1] = copy.deepcopy(r['entries'][0])
            if mode == 'order': r['entries'][0], r['entries'][1] = r['entries'][1], r['entries'][0]
            if mode == 'source': r['entries'][0]['matrix']['source']['endpoint'] = 'SECRET'
            if mode == 'fallback': r['entries'][0]['matrix']['dateResolution']['usedFallback'] = True
            if mode == 'name': r['entries'][7]['matrix']['kind']['name'] = '회사채(무보증)'
            if mode == 'counter': r['dataRowCount'] -= 1
            if mode == 'suppressedError': r['entries'][0] = {'availability': 'unavailable', 'requestedBaseDate': r['requestedDates'][0], 'kind': {'code': '10', 'name': 'synthetic'}, 'reason': 'source_transport_error'}
            with self.subTest(mode=mode): self.check(f, False)

    def test_numeric_rejections(self):
        """Reject missing, non-numeric, and non-finite yield values."""
        for value in [None, True, 'SECRET', float('nan'), float('inf')]:
            f = copy.deepcopy(self.f)
            for e in f['result']['entries'][:9]:
                e['matrix']['rows'][0]['yields']['3M'] = value
            with self.subTest(value=type(value).__name__): self.check(f, False)

    def test_bad_envelopes_and_redaction(self):
        """Reject malformed envelopes and retain only sanitized error fields."""
        self.check(self.f, False, 1)
        error = {'ok': False, 'error': {'code': 'source_transport_error', 'reason': 'SECRET', 'cause': 'TimeoutError', 'actual': {'requestedBaseDate': '2023-05-01', 'kind': {'code': '20', 'name': 'SECRET'}, 'sourceActual': 404}, 'retry': {'attemptCount': 1, 'maxAttempts': 3, 'sourceOperation': 'listYtmMatrix', 'stopReason': 'terminal_failure'}}}
        report = self.check(error, False, 1)
        self.assertEqual(report['terminal']['httpStatus'], 404)
        self.assertNotIn('SECRET', json.dumps(report))
        for raw in [b'SECRET', b'{} {}', b'{"ok":true,"ok":false}', b'null', b'[]', b'\xff']:
            report = c.assess(raw, 0)
            self.assertFalse(report['accepted'])
            self.assertNotIn('SECRET', json.dumps(report))

    def test_preflight_failure_finishes_reserved_report(self):
        """Finalize the reservation when the candidate version check fails."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / 'candidate'
            binary.write_text('#!/usr/bin/env python3\nimport sys\nsys.exit(7)\n')
            binary.chmod(0o700)
            provenance_path = root / 'provenance.json'
            write_provenance(provenance_path, binary)
            report_path = root / 'report.json'
            argv = ['checker', '--binary', str(binary), '--provenance', str(provenance_path), '--report', str(report_path)]
            with mock.patch.object(sys, 'argv', argv), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(c.main(), 1)
            report = json.loads(report_path.read_text())
            self.assertEqual(report['state'], 'finished')
            self.assertFalse(report['accepted'])
            self.assertEqual(report['blocker'], c.PREFLIGHT_BLOCKER)

    def test_preflight_timeout_finishes_reserved_report(self):
        """Finalize the reservation when the candidate version check times out."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / 'candidate'
            binary.write_text('#!/usr/bin/env python3\nimport time\ntime.sleep(2)\n')
            binary.chmod(0o700)
            provenance_path = root / 'provenance.json'
            write_provenance(provenance_path, binary)
            report_path = root / 'report.json'
            argv = ['checker', '--binary', str(binary), '--provenance', str(provenance_path), '--report', str(report_path)]
            with mock.patch.object(c, 'PREFLIGHT_TIMEOUT_SECONDS', 0.05), \
                    mock.patch.object(sys, 'argv', argv), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(c.main(), 1)
            report = json.loads(report_path.read_text())
            self.assertEqual(report['state'], 'finished')
            self.assertFalse(report['accepted'])
            self.assertEqual(report['blocker'], c.PREFLIGHT_BLOCKER)

    def test_provenance_mismatch_rejects_candidate(self):
        """Reject a provenance sidecar that does not match the candidate bytes."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / 'candidate'
            binary.write_text('#!/usr/bin/env python3\nprint("ytm synthetic")\n')
            binary.chmod(0o700)
            provenance_path = root / 'provenance.json'
            provenance_path.write_text(json.dumps({
                'sourceCommit': 'a' * 40,
                'binarySha256': '0' * 64,
                'version': 'ytm synthetic',
            }))
            report_path = root / 'report.json'
            argv = ['checker', '--binary', str(binary), '--provenance', str(provenance_path), '--report', str(report_path)]
            with mock.patch.object(sys, 'argv', argv), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(c.main(), 1)
            report = json.loads(report_path.read_text())
            self.assertEqual(report['state'], 'finished')
            self.assertFalse(report['accepted'])
            self.assertEqual(report['blocker'], c.PREFLIGHT_BLOCKER)

    def test_streaming_stdout_hits_bounded_output_path(self):
        """Kill and reap a candidate that continuously exceeds stdout capacity."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / 'candidate'
            binary.write_text(
                '#!/usr/bin/env python3\n'
                'import os\n'
                'import sys\n'
                "if sys.argv[1:] == ['--version']:\n"
                "    print('ytm synthetic')\n"
                'else:\n'
                '    while True:\n'
                "        os.write(sys.stdout.fileno(), b'x' * 65536)\n")
            binary.chmod(0o700)
            provenance_path = root / 'provenance.json'
            write_provenance(provenance_path, binary)
            report_path = root / 'report.json'
            argv = ['checker', '--binary', str(binary), '--provenance', str(provenance_path), '--report', str(report_path)]
            with mock.patch.object(c, 'OUTPUT_LIMIT_BYTES', 1024), \
                    mock.patch.object(sys, 'argv', argv), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(c.main(), 1)
            report = json.loads(report_path.read_text())
            self.assertEqual(report['state'], 'finished')
            self.assertFalse(report['accepted'])
            self.assertEqual(report['blocker'], c.OUTPUT_LIMIT_BLOCKER)


if __name__ == '__main__':
    unittest.main()
