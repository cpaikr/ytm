#!/usr/bin/env python3
"""One-off assessment: provider stdout stays bounded in memory; only fixed metadata escapes.

Offline: python3 scripts/test-history-live-acceptance.py
Live: pass --binary /absolute/release/ytm --provenance /path/build-provenance.json
and --report /new/sanitized-report.json.
The provenance JSON must bind sourceCommit, binarySha256, and version to the
supplied candidate artifact.
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
import queue
import re
import subprocess
import threading
import time

END = '2023-06-30'
COUNT = 180
DEADLINE_SECONDS = 1800
WATCHDOG_SECONDS = 1860
PREFLIGHT_TIMEOUT_SECONDS = 10
PREFLIGHT_OUTPUT_LIMIT_BYTES = 64 * 1024
PROVENANCE_LIMIT_BYTES = 64 * 1024
OUTPUT_LIMIT_BYTES = 32 * 1024 * 1024
READ_CHUNK_BYTES = 64 * 1024
PREFLIGHT_BLOCKER = 'candidate_preflight_failed'
OUTPUT_LIMIT_BLOCKER = 'process_output_limit_exceeded'
CODES = ['10', '20', '30', '40', '50', '60', '70', '80']
NAMES = ['국채', '지방채', '특수채', '통안채', '은행채', '기타금융채', '회사채(무보증)', '회사채(사모)']
TENORS = ['3M', '6M', '9M', '1Y', '1.5Y', '2Y', '2.5Y', '3Y', '5Y', '7Y', '10Y', '15Y', '20Y', '30Y', '50Y']
CHECKS = ['exitZero', 'successfulEnvelope', 'selectedDates', 'scanMetadata', 'categoryProcessing', 'exactDates', 'sourceIdentity', 'numericQualification', 'counters']


class CandidatePreflightFailure(Exception):
    """Signal that the candidate version preflight did not complete safely."""


class OutputLimitExceeded(Exception):
    """Signal that a candidate emitted more stdout than the checker allows."""


class ProcessWatchdogExpired(Exception):
    """Signal that a candidate exceeded the checker process watchdog."""


class OutputCaptureFailure(Exception):
    """Signal that the bounded stdout reader could not finish normally."""


def require(condition):
    """Raise when an acceptance invariant is false."""
    if not condition:
        raise ValueError("acceptance check failed")


def date(value):
    """Return whether value is a canonical ISO calendar date string."""
    return isinstance(value, str) and len(value) == 10 and dt.date.fromisoformat(value).isoformat() == value


def source(day, code):
    """Build the stable source identity expected for one matrix entry."""
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
    """Validate candidate output while keeping provider details out of reports."""
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


def _kill_and_reap(proc):
    """Kill a still-running process and wait until its process entry is reaped."""
    try:
        if proc.poll() is None:
            proc.kill()
    except OSError:
        pass
    proc.wait()


def _capture_stdout(stream, result_queue, output_limit):
    """Read stdout into a byte-limited buffer and publish one terminal result."""
    output = bytearray()
    try:
        while True:
            room = output_limit + 1 - len(output)
            chunk = stream.read(min(READ_CHUNK_BYTES, room))
            if not chunk:
                result_queue.put(('complete', bytes(output)))
                return
            output.extend(chunk)
            if len(output) > output_limit:
                result_queue.put(('output_limit', None))
                return
    except Exception:
        result_queue.put(('reader_failure', None))


def run_bounded_process(command, *, env, timeout_seconds, output_limit):
    """Run a command with a deadline and bounded stdout capture."""
    if timeout_seconds <= 0 or output_limit < 0:
        raise ValueError('invalid process bounds')
    proc = subprocess.Popen(command, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, env=env, bufsize=0)
    result_queue = queue.Queue(maxsize=1)
    reader = threading.Thread(target=_capture_stdout,
                              args=(proc.stdout, result_queue, output_limit),
                              daemon=True)
    reader.start()
    deadline = time.monotonic() + timeout_seconds
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ProcessWatchdogExpired
            try:
                status, raw = result_queue.get(timeout=min(remaining, 0.25))
            except queue.Empty:
                continue
            if status == 'output_limit':
                raise OutputLimitExceeded
            if status == 'reader_failure':
                raise OutputCaptureFailure
            if status != 'complete':
                raise OutputCaptureFailure
            try:
                exit_code = proc.wait(timeout=max(0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                raise ProcessWatchdogExpired from None
            return raw, exit_code
    except BaseException:
        _kill_and_reap(proc)
        raise
    finally:
        if proc.stdout is not None:
            proc.stdout.close()
        reader.join(timeout=1)


def load_provenance(provenance_path, binary_sha256):
    """Load and verify build provenance against the supplied binary bytes."""
    try:
        if provenance_path.stat().st_size > PROVENANCE_LIMIT_BYTES:
            raise CandidatePreflightFailure
        provenance = json.loads(provenance_path.read_text(encoding='utf-8'))
        if not isinstance(provenance, dict) or set(provenance) != {'sourceCommit', 'binarySha256', 'version'}:
            raise CandidatePreflightFailure
        source_commit = provenance['sourceCommit']
        digest = provenance['binarySha256']
        version = provenance['version']
        if not isinstance(source_commit, str) or not re.fullmatch(r'[0-9a-f]{40}', source_commit):
            raise CandidatePreflightFailure
        if not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest):
            raise CandidatePreflightFailure
        if digest != binary_sha256:
            raise CandidatePreflightFailure
        if not isinstance(version, str) or not version or len(version) > PREFLIGHT_OUTPUT_LIMIT_BYTES:
            raise CandidatePreflightFailure
        return {'sourceCommit': source_commit, 'version': version}
    except Exception:
        raise CandidatePreflightFailure from None


def shell_identity():
    """Return the shell path advertised by the current execution environment."""
    shell = os.environ.get('SHELL') or os.environ.get('ComSpec')
    return shell if isinstance(shell, str) and shell and '\n' not in shell and '\r' not in shell else 'unknown'


def candidate_version(binary, env):
    """Run the short, bounded candidate version preflight."""
    try:
        raw, exit_code = run_bounded_process(
            [str(binary), '--version'],
            env=env,
            timeout_seconds=PREFLIGHT_TIMEOUT_SECONDS,
            output_limit=PREFLIGHT_OUTPUT_LIMIT_BYTES)
        if exit_code != 0:
            raise CandidatePreflightFailure
        return raw.decode('utf-8').strip()
    except Exception:
        raise CandidatePreflightFailure from None


def finish_report(report, report_path, started):
    """Finalize, persist, and print the sanitized attempt report."""
    report.update({'state': 'finished',
                   'endUtc': dt.datetime.now(dt.timezone.utc).isoformat(),
                   'elapsedSeconds': round(time.monotonic() - started, 3)})
    serialized = json.dumps(report, indent=2) + '\n'
    report_path.write_text(serialized)
    print(serialized, end='')


def main():
    """Reserve one report, preflight the candidate, and assess one bounded run."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', required=True, type=Path)
    parser.add_argument('--provenance', required=True, type=Path)
    parser.add_argument('--report', required=True, type=Path)
    args = parser.parse_args()
    report = {'state': 'attempt_reserved', 'deadlineSeconds': DEADLINE_SECONDS}
    # Refuse to overwrite an earlier run, even an interrupted reservation.
    with args.report.open('x') as f:
        json.dump(report, f, indent=2)
    report['startUtc'] = dt.datetime.now(dt.timezone.utc).isoformat()
    started = time.monotonic()
    try:
        binary = args.binary.resolve(strict=True)
        env = {k: v for k, v in os.environ.items() if not k.startswith(('YTM_', 'KISNET_', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'))}
        binary_sha256 = hashlib.sha256(binary.read_bytes()).hexdigest()
        provenance = load_provenance(args.provenance, binary_sha256)
        version = candidate_version(binary, env)
        if version != provenance['version']:
            raise CandidatePreflightFailure
        identity = {'sourceCommit': provenance['sourceCommit'],
                    'binaryPath': str(binary), 'sha256': binary_sha256,
                    'platform': platform.platform(), 'shell': shell_identity(),
                    'version': version}
        report['candidate'] = identity
    except Exception:
        report.update({'accepted': False, 'blocker': PREFLIGHT_BLOCKER})
        finish_report(report, args.report, started)
        return 1
    try:
        raw, exit_code = run_bounded_process(
            [str(binary), 'history', '--end-date', END, '--count', str(COUNT),
             '--format', 'json', '--operation-timeout-seconds', str(DEADLINE_SECONDS)],
            env=env, timeout_seconds=WATCHDOG_SECONDS,
            output_limit=OUTPUT_LIMIT_BYTES)
        report.update(assess(raw, exit_code))
        report['exitCode'] = exit_code
    except ProcessWatchdogExpired:
        report.update({'accepted': False, 'blocker': 'process_watchdog_1860_seconds'})
    except OutputLimitExceeded:
        report.update({'accepted': False, 'blocker': OUTPUT_LIMIT_BLOCKER})
    except Exception:
        report.update({'accepted': False, 'blocker': 'runner_failure'})
    finish_report(report, args.report, started)
    return 0 if report.get('accepted') is True else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        # No dependency exception can reveal source data.
        print('{"accepted":false,"blocker":"runner_preflight_or_report_failure"}')
        raise SystemExit(1)
