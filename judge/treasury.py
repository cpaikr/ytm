#!/usr/bin/env python3
"""Black-box Treasury yield curve acceptance through public surfaces (no network).

Treasury is a source separate from KIS-NET; these scenarios use only the
fictional CSV corpus in contracts/treasury and the judge fixture transport.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / 'contracts' / 'treasury'
PATH = '/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/{year}/all'
URL = ('https://home.treasury.gov' + PATH +
       '?type=daily_treasury_yield_curve&field_tdr_date_value={year}&page&_format=csv')
FAILURES = []


def check(condition, message):
    if not condition:
        FAILURES.append(message)


def step(year, fixture=None, **extra):
    value = {'path': PATH.format(year=year)}
    if fixture:
        value['fixture'] = fixture
    value.update(extra)
    return value


def environment(steps, capture):
    env = {k: v for k, v in os.environ.items() if not k.startswith('YTM_JUDGE_')}
    env['YTM_JUDGE_FIXTURE'] = json.dumps({'fixtureDirectory': str(FIXTURES), 'steps': steps})
    env['YTM_JUDGE_CAPTURE_PATH'] = str(capture)
    return env


class Surfaces:
    def __init__(self, cli, node):
        self.cli = cli
        self.node = node
        self.scratch = Path(tempfile.mkdtemp(prefix='ytm-treasury-judge-'))

    def run_cli(self, args, steps, cwd=None):
        capture = self.scratch / 'capture.json'
        capture.unlink(missing_ok=True)
        result = subprocess.run([self.cli, 'treasury', *args], capture_output=True, text=True,
                                encoding='utf-8', env=environment(steps, capture), cwd=cwd,
                                timeout=30)
        requests = json.loads(capture.read_text(encoding='utf-8')) if capture.exists() else []
        return result, requests

    def run_node(self, request, steps):
        if not self.node:
            return None, []
        capture = self.scratch / 'capture.json'
        capture.unlink(missing_ok=True)
        client = (ROOT / 'packages' / 'node' / 'dist' / 'client.js').as_uri()
        script = (f'const m = await import({json.dumps(client)});'
                  'const client = new m.YtmClient();'
                  f'try {{ const value = await client.treasuryCurve({json.dumps(request)});'
                  ' process.stdout.write(JSON.stringify({ ok: true, value })); }'
                  ' catch (error) { process.stdout.write(JSON.stringify({ ok: false,'
                  ' name: error.name, code: error.code, details: error.details })); }')
        result = subprocess.run([self.node, '--input-type=module', '-e', script],
                                capture_output=True, text=True, encoding='utf-8',
                                env=environment(steps, capture), timeout=30)
        requests = json.loads(capture.read_text(encoding='utf-8')) if capture.exists() else []
        check(result.returncode == 0, f'node treasury runner failed: {result.stderr}')
        return json.loads(result.stdout or '{}'), requests


def curve(entry):
    check(entry.get('availability') == 'available', f'expected available entry: {entry}')
    return entry.get('curve', {})


def assert_years(requests, years, label):
    check([r.get('url') for r in requests] == [URL.format(year=y) for y in years],
          f'{label}: expected one GET per year {years}, got {[r.get("url") for r in requests]}')
    check(all(r.get('method') == 'GET' and r.get('body') == '' for r in requests),
          f'{label}: Treasury lookups must be bodiless GET requests')


def exact_dates(surfaces):
    steps = [step(2024, 'yield-curve-2024.csv'), step(2025, 'yield-curve-2025.csv')]
    result, requests = surfaces.run_cli(
        ['--base-date', '2025-09-30', '--base-date', '2024-12-31', '--base-date', '20250928'],
        steps)
    check(result.returncode == 0, f'exact: exit {result.returncode} {result.stdout}')
    envelope = json.loads(result.stdout)
    value = envelope['result']
    check(envelope['operation'] == 'treasury', 'exact: operation must be treasury')
    check(value['requestedDates'] == ['2024-12-31', '2025-09-28', '2025-09-30'],
          'exact: dates must normalize and sort')
    check((value['availableCount'], value['unavailableCount']) == (2, 1), 'exact: counts')
    check(value['latestObservationDate'] == '2025-09-30', 'exact: latest observation date')
    last = curve(value['entries'][2])
    check([t['tenor'] for t in last['tenors']][:3] == ['1M', '1.5M', '2M'], 'exact: tenor order')
    three_month = next(t for t in last['tenors'] if t['tenor'] == '3M')
    check(three_month == {'tenor': '3M', 'label': '3 Mo', 'months': 3, 'yield': 3.96,
                          'yieldText': '3.96'}, f'exact: tenor shape {three_month}')
    older = curve(value['entries'][0])
    check(all(t['tenor'] != '1.5M' for t in older['tenors']),
          'exact: 2024 observations keep only that year\'s published columns')
    check(value['entries'][1] == {
        'availability': 'unavailable', 'requestedBaseDate': '2025-09-28',
        'attemptedDates': ['2025-09-28'], 'mode': 'exact', 'lookbackDays': 0,
        'reason': 'source_data_unavailable: Treasury published no curve for this date'},
        f'exact: unavailable entry {value["entries"][1]}')
    check([f['year'] for f in value['source']['files']] == [2024, 2025], 'exact: source files')
    check(value['statistics']['scannedDateCount'] == 3, 'exact: scanned date count')
    assert_years(requests, [2024, 2025], 'exact')

    node, node_requests = surfaces.run_node(
        {'baseDates': ['2025-09-30', '2024-12-31', '20250928']}, steps)
    if node is not None:
        check(node.get('ok') is True, f'node exact failed: {node}')
        node_value = dict(node.get('value', {}))
        cli_value = dict(value)
        for item in (node_value, cli_value):
            item.pop('statistics', None)
        check(node_value == cli_value, 'node and CLI Treasury results must match')
        assert_years(node_requests, [2024, 2025], 'node exact')


def fallback_and_tabular(surfaces):
    steps = [step(2025, 'yield-curve-2025.csv'), step(2024, 'yield-curve-2024.csv')]
    result, requests = surfaces.run_cli(
        ['--base-date', '2025-01-01', '--base-date', '2025-09-28', '--fallback',
         'previous-available', '--lookback-days', '3', '--format', 'csv'], steps)
    check(result.returncode == 0, f'fallback: exit {result.returncode} {result.stdout}')
    lines = result.stdout.splitlines()
    check(lines[0].startswith('requestedBaseDate,baseDate,usedFallback,availability,reason,1M,1.5M'),
          f'fallback: CSV header {lines[0]}')
    check(lines[1].startswith('2025-01-01,2024-12-31,true,available,,4.34,,4.31,4.3,'),
          f'fallback: cross-year row {lines[1]}')
    check(lines[2].startswith('2025-09-28,2025-09-26,true,available,,4.13,4.12,'),
          f'fallback: weekend row {lines[2]}')
    assert_years(requests, [2025, 2024], 'fallback')


def failures_abort(surfaces):
    result, _ = surfaces.run_cli(['--base-date', '2025-09-30'],
                                 [step(2025, 'invalid-unknown-header.csv')])
    check(result.returncode == 1, f'format: exit {result.returncode}')
    error = json.loads(result.stdout)['error']
    check(error['code'] == 'source_format_error' and error['operationName'] == 'treasury',
          f'format: error identity {error}')
    check('Treasury' in error['recoveryHint'], 'format: Treasury recovery hint')

    result, requests = surfaces.run_cli(['--base-date', '2025-09-30', '--max-retries', '0'],
                                        [step(2025, status=503)])
    error = json.loads(result.stdout)['error']
    check(result.returncode == 1 and error['code'] == 'source_transport_error',
          f'transport: {result.returncode} {error}')
    check(error['actual']['sourceActual'] == 503, f'transport: status context {error}')
    check(len(requests) == 1, 'transport: fixture transports are not retried by the service')

    result, requests = surfaces.run_cli(['--base-date', '2025-09-30', '--kind', '10'], [])
    check(result.returncode == 2 and requests == [], 'invalid: kind is rejected before I/O')

    result, _ = surfaces.run_cli(['--base-date', '1989-06-30'], [step(1989, 'yield-curve-empty.csv')])
    value = json.loads(result.stdout)['result']
    check(result.returncode == 0 and value['availableCount'] == 0
          and value['latestObservationDate'] is None, f'empty year: {value}')


def workbook(surfaces):
    steps = [step(2025, 'yield-curve-2025.csv')]
    cwd = surfaces.scratch / 'xlsx'
    cwd.mkdir(exist_ok=True)
    result, _ = surfaces.run_cli(['--start-date', '2025-09-26', '--end-date', '2025-09-30',
                                  '--format', 'xlsx', '--output', 'curve.xlsx'], steps, cwd=cwd)
    check(result.returncode == 0, f'xlsx: exit {result.returncode} {result.stdout}')
    receipt = json.loads(result.stdout)['result']
    check((receipt['rowCount'], receipt['availableCount'], receipt['unavailableCount'])
          == (5, 3, 2), f'xlsx: receipt {receipt}')
    inspected = subprocess.run(
        [os.environ.get('PYO3_PYTHON') or ('python' if os.name == 'nt' else 'python3'),
         str(ROOT / 'judge' / 'inspect-xlsx.py'), str(cwd / 'curve.xlsx')],
        capture_output=True, text=True, encoding='utf-8')
    check(inspected.returncode == 0, f'xlsx: inspection failed {inspected.stderr}')
    sheets = {sheet['name']: sheet['cells'] for sheet in json.loads(inspected.stdout)['sheets']}
    check(list(sheets) == ['Treasury', 'Metadata'], f'xlsx: sheets {list(sheets)}')
    data = sheets.get('Treasury', {})
    check(data.get('I2', {}).get('value') == 3.98 and data['I2']['type'] == 'number',
          f'xlsx: typed 3M yield {data.get("I2")}')
    check(data.get('D3', {}).get('value') == 'unavailable', 'xlsx: unavailable row')
    metadata = sheets.get('Metadata', {})
    fields = {metadata[f'A{row}']['value']: metadata.get(f'B{row}', {}).get('value')
              for row in range(2, 200) if f'A{row}' in metadata}
    check(fields.get('source.files[0].url') == URL.format(year=2025), 'xlsx: source file url')
    check(fields.get('latestObservationDate') == '2025-09-30', 'xlsx: latest observation')
    with zipfile.ZipFile(cwd / 'curve.xlsx') as archive:
        check(not any('externalLink' in name for name in archive.namelist()), 'xlsx: no links')


def installed_python():
    """Sync and async clients from the installed fixture wheel (run with -I)."""
    import asyncio
    import kisnet_ytm

    def configure(steps):
        os.environ['YTM_JUDGE_FIXTURE'] = json.dumps(
            {'fixtureDirectory': str(FIXTURES), 'steps': steps})
        os.environ.pop('YTM_JUDGE_CAPTURE_PATH', None)

    steps = [step(2024, 'yield-curve-2024.csv'), step(2025, 'yield-curve-2025.csv')]
    configure(steps)
    with kisnet_ytm.Client() as client:
        result = client.treasury_curve(base_dates=['2025-09-30', '2024-12-31', '2025-09-28'])
    check(isinstance(result, kisnet_ytm.TreasuryCurveResult), 'python: result type')
    check(result.requested_dates == ('2024-12-31', '2025-09-28', '2025-09-30'), 'python: dates')
    check((result.available_count, result.unavailable_count) == (2, 1), 'python: counts')
    check(result.latest_observation_date == '2025-09-30', 'python: latest observation')
    last = result.entries[2]
    check(isinstance(last, kisnet_ytm.AvailableTreasuryEntry), 'python: available entry type')
    three_month = next(t for t in last.curve.tenors if t.tenor == '3M')
    check(three_month == kisnet_ytm.TreasuryTenor('3M', '3 Mo', 3.0, 3.96, '3.96'),
          f'python: tenor {three_month}')
    check(isinstance(result.entries[1], kisnet_ytm.UnavailableTreasuryEntry), 'python: unavailable')
    check([f.year for f in result.source.files] == [2024, 2025], 'python: source files')
    check(result.statistics is not None and result.statistics.scanned_date_count == 3,
          'python: statistics')

    async def run_async():
        configure(steps)
        async with kisnet_ytm.AsyncClient() as client:
            return await client.treasury_curve(base_dates=['2025-09-30', '2024-12-31', '2025-09-28'])
    parallel = asyncio.run(run_async())
    check(parallel.entries == result.entries, 'python: async and sync results must match')

    configure([step(2025, 'yield-curve-2025.csv'), step(2024, 'yield-curve-2024.csv')])
    with kisnet_ytm.Client() as client:
        fallback = client.treasury_curve(base_dates=['2025-01-01'], fallback='previous-available',
                                         lookback_days=3)
    entry = fallback.entries[0]
    check(isinstance(entry, kisnet_ytm.AvailableTreasuryEntry)
          and entry.curve.base_date == '2024-12-31'
          and entry.curve.date_resolution.used_fallback, 'python: cross-year fallback')

    configure([step(2025, 'invalid-unknown-header.csv')])
    with kisnet_ytm.Client() as client:
        try:
            client.treasury_curve(base_dates=['2025-09-30'])
            check(False, 'python: format error must raise')
        except kisnet_ytm.SourceFormatError as error:
            check('Treasury' in str(error) or 'Treasury' in json.dumps(getattr(error, 'details', {})),
                  'python: Treasury format error')
    for invalid in ({'base_dates': []}, {'base_dates': ['2025-09-30'], 'lookback_days': 3},
                    {'start_date': '2025-09-30'}):
        with kisnet_ytm.Client() as client:
            try:
                client.treasury_curve(**invalid)
                check(False, f'python: {invalid} must be rejected')
            except kisnet_ytm.InvalidParameterError:
                pass
    os.environ.pop('YTM_JUDGE_FIXTURE', None)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--cli')
    parser.add_argument('--node')
    parser.add_argument('--python', action='store_true')
    args = parser.parse_args()
    if args.python:
        try:
            installed_python()
        except Exception as error:
            FAILURES.append(f'installed_python: {type(error).__name__}: {error}')
        if FAILURES:
            print('\n'.join(f'- {failure}' for failure in FAILURES))
            raise SystemExit(1)
        print('treasury judge passed installed Python clients')
        return
    surfaces = Surfaces(str(Path(args.cli).resolve()), args.node)
    for scenario in (exact_dates, fallback_and_tabular, failures_abort, workbook):
        try:
            scenario(surfaces)
        except Exception as error:  # Report every scenario rather than stopping at one.
            FAILURES.append(f'{scenario.__name__}: {type(error).__name__}: {error}')
    if FAILURES:
        print('\n'.join(f'- {failure}' for failure in FAILURES))
        raise SystemExit(1)
    print('treasury judge passed 4 scenario group(s)')


if __name__ == '__main__':
    main()
