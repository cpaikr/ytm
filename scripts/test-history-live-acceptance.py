"""Synthetic acceptance/rejection and redaction checks; no provider access."""
import contextlib
import copy
import datetime as dt
import importlib.util
import io
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('checker', Path(__file__).with_name('check-history-live-acceptance.py'))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


def fixture():
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


class CheckerTests(unittest.TestCase):
    def setUp(self):
        self.f = fixture()

    def check(self, f, expected, exit_code=0):
        capture = io.StringIO()
        with contextlib.redirect_stdout(capture), contextlib.redirect_stderr(capture):
            report = c.assess(json.dumps(f), exit_code)
        self.assertEqual(report['accepted'], expected)
        self.assertEqual(capture.getvalue(), '')
        return report

    def test_success_and_unavailable(self):
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
        for value in [None, True, 'SECRET', float('nan'), float('inf')]:
            f = copy.deepcopy(self.f)
            for e in f['result']['entries'][:9]:
                e['matrix']['rows'][0]['yields']['3M'] = value
            with self.subTest(value=type(value).__name__): self.check(f, False)

    def test_bad_envelopes_and_redaction(self):
        self.check(self.f, False, 1)
        error = {'ok': False, 'error': {'code': 'source_transport_error', 'reason': 'SECRET', 'cause': 'TimeoutError', 'actual': {'requestedBaseDate': '2023-05-01', 'kind': {'code': '20', 'name': 'SECRET'}, 'sourceActual': 404}, 'retry': {'attemptCount': 1, 'maxAttempts': 3, 'sourceOperation': 'listYtmMatrix', 'stopReason': 'terminal_failure'}}}
        report = self.check(error, False, 1)
        self.assertEqual(report['terminal']['httpStatus'], 404)
        self.assertNotIn('SECRET', json.dumps(report))
        for raw in [b'SECRET', b'{} {}', b'{"ok":true,"ok":false}', b'null', b'[]', b'\xff']:
            report = c.assess(raw, 0)
            self.assertFalse(report['accepted'])
            self.assertNotIn('SECRET', json.dumps(report))


if __name__ == '__main__':
    unittest.main()
