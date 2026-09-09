#!/usr/bin/env python3
"""One-off assessment: provider stdout stays in memory; only fixed metadata escapes.

Offline: python3 scripts/test-history-live-acceptance.py
Live: pass --binary /absolute/release/ytm --report /new/sanitized-report.json.
The exclusive report reservation consumes the attempt even if execution fails.
No retries, source routing, retained payloads, or successful-retry inference.
"""
import argparse
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import subprocess
import time

END = '2023-06-30'
COUNT = 180
CODES = ['10', '20', '30', '40', '50', '60', '70', '80']
NAMES = ['국채', '지방채', '특수채', '통안채', '은행채', '기타금융채', '회사채(무보증)', '회사채(사모)']
TENORS = ['3M', '6M', '9M', '1Y', '1.5Y', '2Y', '2.5Y', '3Y', '5Y', '7Y', '10Y', '15Y', '20Y', '30Y', '50Y']
CHECKS = ['exitZero', 'successfulEnvelope', 'selectedDates', 'scanMetadata', 'categoryProcessing', 'exactDates', 'sourceIdentity', 'numericQualification', 'counters']


def require(condition):
    if not condition:
        raise ValueError("acceptance check failed")


def date(value):
    return isinstance(value, str) and len(value) == 10 and dt.date.fromisoformat(value).isoformat() == value


def source(day, code):
    return {'pageUrl': 'https://kis-net.kr/kisnet_mobile/index.html',
            'endpoint': 'https://kis-net.kr/rateInfo/ytmMatrixMobileList.do', 'method': 'POST',
            'request': {'format': 'Nexacro XML PlatformData',
                        'inDatasets': 'ds_search=ds_search gds_tranInfo=gds_tranInfo',
                        'outDatasets': 'ds_list=output1',
                        'parameters': {'calBaseDt': day.replace('-', ''), 'cboYtmSort': code}},
            'inspectedWorkflow': 'The mobile page posts ds_search to /rateInfo/ytmMatrixMobileList.do when 검색 is clicked.'}


def terminal(error):
    """Never emit arbitrary messages, labels, reason, actual objects, or values."""
    out = {}
    for key, allowed in {
        'code': ['source_transport_error', 'source_format_error', 'source_protocol_error', 'insufficient_history', 'source_data_unavailable'],
        'cause': ['TimeoutError', 'AbortError', 'ConnectError', 'RequestError'],
    }.items():
        if error.get(key) in allowed:
            out[key] = error[key]
    retry = error.get('retry')
    if isinstance(retry, dict):
        for key in ['attemptCount', 'maxAttempts']:
            if type(retry.get(key)) is int and 0 <= retry[key] <= 3:
                out[key] = retry[key]
        for key, allowed in {'stopReason': ['terminal_failure', 'attempt_exhaustion', 'operation_deadline', 'cancellation'], 'sourceOperation': ['initializeYtmMatrix', 'listYtmMatrix']}.items():
            if retry.get(key) in allowed:
                out[key] = retry[key]
    actual = error.get('actual')
    if isinstance(actual, dict):
        for key in ['attemptedDate', 'requestedBaseDate']:
            try:
                if date(actual.get(key)):
                    out[key] = actual[key]
            except ValueError:
                pass
        kind = actual.get('kind')
        if isinstance(kind, dict) and kind.get('code') in CODES:
            out['kindCode'] = kind['code']
        actual = actual.get('sourceActual')
    if type(actual) is int and 100 <= actual <= 599:
        out['httpStatus'] = actual
    return out


def assess(raw, exit_code):
    report = {'accepted': False, 'checks': dict.fromkeys(CHECKS, 'not_evaluable'),
              'requestedCount': COUNT, 'selectedCount': None, 'scannedCount': None}
    checks = report['checks']
    checks['exitZero'] = 'pass' if exit_code == 0 else 'fail'
    stage = 'successfulEnvelope'
    try:
        # JSON decoder errors can contain payload fragments: never propagate them.
        def pairs(items):
            obj = {}
            for key, value in items:
                if key in obj:
                    raise ValueError('duplicate key')
                obj[key] = value
            return obj
        def nonfinite(_):
            raise ValueError('nonfinite')
        envelope = json.loads(raw, object_pairs_hook=pairs, parse_constant=nonfinite)
        require(isinstance(envelope, dict))
        if envelope.get('ok') is False:
            checks[stage] = 'fail'
            if isinstance(envelope.get('error'), dict):
                report['terminal'] = terminal(envelope['error'])
            return report
        require(envelope.get('ok') is True and envelope.get('operation') == 'history')
        r = envelope['result']
        require(isinstance(r, dict))
        checks[stage] = 'pass'
        stage = 'selectedDates'
        dates = r['requestedDates']
        require(isinstance(dates, list))
        report['selectedCount'] = len(dates)
        require(len(dates) == COUNT and all(date(d) and d <= END for d in dates))
        require(dates == sorted(set(dates)))
        checks[stage] = 'pass'
        stage = 'scanMetadata'
        c = r['countSelection']
        require(type(c['count']) is int and c['count'] == COUNT and c['endDate'] == END and 'startDate' not in c)
        require(c['scannedStartDate'] == dates[0])
        require(type(c['scannedDateCount']) is int)
        require(c['scannedDateCount'] == (dt.date.fromisoformat(END) - dt.date.fromisoformat(dates[0])).days + 1)
        require(COUNT <= c['scannedDateCount'] <= 2000)
        report['scannedCount'] = c['scannedDateCount']
        checks[stage] = 'pass'
        stage = 'categoryProcessing'
        require(r['discovery'] == [{'requestedBaseDate': d, 'available': True} for d in dates])
        entries = r['entries']
        require(isinstance(entries, list))
        grouped = {d: [] for d in dates}
        sequence = []
        for e in entries:
            require(e['availability'] in ['available', 'unavailable'])
            item = e['matrix'] if e['availability'] == 'available' else e
            d, kind = item['requestedBaseDate'], item['kind']
            require(d in grouped and isinstance(kind['code'], str) and kind['code'] and isinstance(kind['name'], str) and kind['name'])
            grouped[d].append(e)
            sequence.append(d)
        require(sequence == sorted(sequence))
        for day_entries in grouped.values():
            codes = [(e.get('matrix') or e)['kind']['code'] for e in day_entries]
            require(codes[:8] == CODES and len(codes) == len(set(codes)))
            require([(e.get('matrix') or e)['kind']['name'] for e in day_entries[:8]] == NAMES)
        checks[stage] = 'pass'
        stage = 'exactDates'
        require(r['mode'] == 'exact' and r['lookbackDays'] == 0)
        for d, day_entries in grouped.items():
            for e in day_entries:
                if e['availability'] == 'available':
                    m = e['matrix']
                    require(m['baseDate'] == d)
                    require(m['dateResolution'] == {'mode': 'exact', 'requestedBaseDate': d, 'resolvedBaseDate': d, 'usedFallback': False, 'attemptedDates': [d], 'lookbackDays': 0})
                else:
                    require('matrix' not in e and e['mode'] == 'exact' and e['lookbackDays'] == 0 and e['attemptedDates'] == [d])
                    require(e['stage'] == 'matrix' and e['reason'] == 'source_data_unavailable: matrix returned no rows')
        checks[stage] = 'pass'
        stage = 'sourceIdentity'
        for e in entries:
            if e['availability'] == 'available':
                m = e['matrix']
                require(m['source'] == source(m['baseDate'], m['kind']['code']))
        checks[stage] = 'pass'
        stage = 'numericQualification'
        rows = 0
        for day_entries in grouped.values():
            numeric = False
            for e in day_entries:
                if e['availability'] == 'unavailable':
                    continue
                m = e['matrix']
                require(m['tenors'] == TENORS and isinstance(m['rows'], list) and m['rows'])
                for row in m['rows']:
                    require(isinstance(row['pricingGroupCode'], str) and row['pricingGroupCode'])
                    require(isinstance(row['pricingGroupName'], str) and row['pricingGroupName'])
                    require(set(row['yields']) == set(TENORS))
                    for value in row['yields'].values():
                        require(value is None or (type(value) in [int, float] and math.isfinite(value)))
                        numeric |= value is not None
                    rows += 1
            require(numeric)
        checks[stage] = 'pass'
        stage = 'counters'
        available = sum(e['availability'] == 'available' for e in entries)
        for key, value in [('availableCount', available), ('unavailableCount', len(entries) - available), ('dataRowCount', rows)]:
            require(type(r[key]) is int and r[key] == value)
        checks[stage] = 'pass'
        report['accepted'] = all(v == 'pass' for v in checks.values())
    except Exception:
        # Security boundary: no exception text/traceback or provider value escapes.
        checks[stage] = 'fail'
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', required=True, type=Path)
    parser.add_argument('--report', required=True, type=Path)
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith(('YTM_', 'KISNET_', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'))}
    identity = {'sourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
                'binaryPath': str(binary), 'sha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
                'platform': platform.platform(), 'shell': '/bin/zsh 5.9',
                'version': subprocess.check_output([str(binary), '--version'], env=env, text=True).strip()}
    report = {'state': 'attempt_reserved', 'candidate': identity, 'deadlineSeconds': 1800}
    # Refuse to overwrite an earlier run, even an interrupted reservation.
    with args.report.open('x') as f:
        json.dump(report, f, indent=2)
    report['startUtc'] = dt.datetime.now(dt.timezone.utc).isoformat()
    started = time.monotonic()
    try:
        proc = subprocess.Popen([str(binary), 'history', '--end-date', END, '--count', str(COUNT), '--format', 'json', '--operation-timeout-seconds', '1800'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env)
        try:
            raw, _ = proc.communicate(timeout=1860)
            report.update(assess(raw, proc.returncode))
            report['exitCode'] = proc.returncode
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
            report.update({'accepted': False, 'blocker': 'process_watchdog_1860_seconds'})
    except Exception:
        report.update({'accepted': False, 'blocker': 'runner_failure'})
    report.update({'state': 'finished', 'endUtc': dt.datetime.now(dt.timezone.utc).isoformat(), 'elapsedSeconds': round(time.monotonic() - started, 3)})
    args.report.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # No dependency exception can reveal source data.
        print('{"accepted":false,"blocker":"runner_preflight_or_report_failure"}')
        raise SystemExit(1)
