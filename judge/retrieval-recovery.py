#!/usr/bin/env python3
"""Deterministic public-surface acceptance through the guarded real HTTP path."""
import argparse
import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parent.parent
INIT = '/rateInfo/ytmMatrixMobileInitList.do'
MATRIX = '/rateInfo/ytmMatrixMobileList.do'


def xml(rows):
    return ('<Root xmlns="http://www.nexacroplatform.com/platform/dataset">'
            '<Parameters><Parameter id="ErrorCode">0</Parameter></Parameters>'
            '<Dataset id="output1"><Rows>' + rows + '</Rows></Dataset></Root>').encode()


CATALOG = xml('<Row><Col id="divCode">10</Col><Col id="divName">국채</Col></Row>')
MATRIX_BODY = xml('<Row><Col id="pricingGroupCode">001</Col><Col id="pricingGroupName">synthetic</Col>' +
                  ''.join('<Col id="' + key + '">-0.500</Col>' for key in
                          'm3 m6 m9 y1 y15a y2 y25 y3 y5 y7 y10 y15 y20 y30 y50'.split()) + '</Row>')


class Source:
    def __init__(self, scenario):
        self.scenario = scenario
        self.requests = []
        self.lock = threading.Lock()
        source = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *args):
                pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers['Content-Length']))
                with source.lock:
                    index = len(source.requests)
                    source.requests.append((self.path, body, tuple(self.headers.items())))
                assert self.path in (INIT, MATRIX), self.path
                status, payload, guidance = 200, CATALOG if self.path == INIT else MATRIX_BODY, None
                fail_at = 0 if scenario == 'initialization' else 16
                if (scenario in ('recovery', 'initialization') and index == fail_at) or (scenario == 'exhaustion' and 16 <= index <= 18):
                    status, payload = 503, b''
                if scenario == 'guidance' and index == 16:
                    status, payload, guidance = 503, b'', '2'
                if scenario in ('timeout', 'body') and index == 16:
                    if scenario == 'timeout':
                        # The client deadline must abort before headers arrive.
                        time.sleep(2)
                    else:
                        self.send_response(200)
                        self.send_header('Content-Length', '99999')
                        self.send_header('Connection', 'close')
                        self.end_headers()
                        self.wfile.write(b'<Root>partial')
                        self.wfile.flush()
                        self.close_connection = True
                        return
                try:
                    self.send_response(status)
                    self.send_header('Content-Type', 'text/xml; charset=UTF-8')
                    self.send_header('Content-Length', str(len(payload)))
                    self.send_header('Connection', 'close')
                    if guidance:
                        self.send_header('Retry-After', guidance)
                    self.end_headers()
                    self.wfile.write(payload)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                self.close_connection = True

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def environment(self):
        env = {key: value for key, value in os.environ.items() if not key.startswith('YTM_JUDGE_')}
        env['YTM_JUDGE_HTTP_ORIGIN'] = 'http://127.0.0.1:' + str(self.server.server_port)
        return env


NODE = r'''
import {YtmClient, serializeYtmError} from __PACKAGE__;
const client = new YtmClient();
try {
  const result = await client.history({baseDates: ['2026-06-08', '2026-06-09']}, __OPTIONS__);
  console.log(JSON.stringify({ok: true, result}));
} catch (error) {
  const details = serializeYtmError(error);
  const kinds = await client.kinds({baseDate: '2026-06-10'}, {operationTimeoutMs: 1000});
  console.log(JSON.stringify({ok: false, error: details, reuseKinds: kinds.kinds.length}));
}
'''

PYTHON = r'''
import asyncio, dataclasses, json
from collections.abc import Mapping
from kisnet_ytm import Client, AsyncClient, YtmError

def thaw(value):
    if dataclasses.is_dataclass(value):
        return {field.name: thaw(getattr(value, field.name)) for field in dataclasses.fields(value)}
    if isinstance(value, Mapping): return {key: thaw(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)): return [thaw(item) for item in value]
    return value

def failure(error, kinds):
    if 'retry' in error.details:
        try: error.details['retry']['attemptCount'] = 999
        except TypeError: pass
        else: raise AssertionError('retry details must remain immutable')
    return dict(ok=False, error=thaw(error.details), reuseKinds=len(kinds.kinds))

async def async_run():
    async with AsyncClient() as client:
        try:
            result = await client.history(base_dates=['2026-06-08', '2026-06-09'], __OPTIONS__)
            return dict(ok=True, result=thaw(result))
        except YtmError as error:
            kinds = await client.kinds(base_date='2026-06-10', operation_timeout_seconds=1)
            return failure(error, kinds)

if __ASYNC__:
    result = asyncio.run(async_run())
else:
    with Client() as client:
        try:
            result = dict(ok=True, result=thaw(client.history(base_dates=['2026-06-08', '2026-06-09'], __OPTIONS__)))
        except YtmError as error:
            result = failure(error, client.kinds(base_date='2026-06-10', operation_timeout_seconds=1))
print(json.dumps(result))
'''


def invoke(surface, executable, source, output):
    short = source.scenario in ('timeout', 'guidance')
    if surface == 'cli':
        command = [executable, 'history', '--base-date', '2026-06-08', '--base-date', '2026-06-09']
        if short:
            command += ['--operation-timeout-seconds', '1']
        if source.scenario in ('exhaustion', 'timeout', 'guidance'):
            command += ['--format', 'xlsx', '--output', str(output), '--overwrite']
    elif surface == 'node':
        script = NODE.replace('__PACKAGE__', json.dumps((ROOT / 'packages/node/dist/client.js').as_uri()))
        script = script.replace('__OPTIONS__', '{operationTimeoutMs: 1000}' if short else '{}')
        command = [executable, '--input-type=module', '-e', script]
    else:
        script = PYTHON.replace('__OPTIONS__', 'operation_timeout_seconds=1' if short else '')
        script = script.replace('__ASYNC__', 'True' if surface == 'python-async' else 'False')
        command = [executable, '-I', '-c', script]
    result = subprocess.run(command, env=source.environment(), capture_output=True, text=True, timeout=15)
    assert result.stderr == '', (surface, source.scenario, result.stderr)
    envelope = json.loads(result.stdout)
    assert result.returncode == (1 if surface == 'cli' and not envelope['ok'] else 0), result.stdout
    return envelope


def validate_options(surface, executable):
    with Source('baseline') as source:
        if surface == 'cli':
            for operation in ('history', 'matrix', 'kinds'):
                inputs = ['--base-date', '2026-06-09'] + (['--kind', '10'] if operation == 'matrix' else [])
                for value in ('0', '-1', '1.5', 'NaN', 'Infinity', 'true', '18446744073709551616'):
                    result = subprocess.run([executable, operation, *inputs, '--operation-timeout-seconds', value],
                                            env=source.environment(), capture_output=True, text=True, timeout=5)
                    error = json.loads(result.stdout)['error']
                    assert result.returncode == 2, result
                    assert result.stderr.startswith('\n' + operation + '\n'), result.stderr
                    assert '--operation-timeout-seconds <positive integer>' in result.stderr, result.stderr
                    assert error['code'] == 'invalid_parameter' and error['parameter'] == 'operationTimeoutSeconds', error
        elif surface == 'node':
            script = r'''import assert from 'node:assert/strict';
import {YtmClient} from __PACKAGE__;
const client = new YtmClient();
for (const [method, input] of [['history', {baseDates:['2026-06-09']}], ['matrix', {baseDate:'2026-06-09',kind:'10'}], ['kinds',{baseDate:'2026-06-09'}]]) {
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, true, '1', null, [], {}]) {
    await assert.rejects(client[method](input, {operationTimeoutMs:value}), error => error.details.code === 'invalid_parameter' && error.details.parameter === 'operationTimeoutMs');
  }
  for (const value of [null, [], 1, 'options']) {
    await assert.rejects(client[method](input, value), error => error.details.code === 'invalid_parameter' && error.details.parameter === 'options');
  }
}
await assert.rejects(client.history({unknown:true}, {operationTimeoutMs:0}), error => error.details.code === 'unknown_parameter');
assert.equal((await client.kinds({}, {operationTimeoutMs:1})).kinds.length, 8);
'''.replace('__PACKAGE__', json.dumps((ROOT / 'packages/node/dist/client.js').as_uri()))
            result = subprocess.run([executable, '--input-type=module', '-e', script], env=source.environment(), capture_output=True, text=True, timeout=10)
            assert result.returncode == 0 and result.stderr == '', result.stderr
        else:
            script = r'''import asyncio
from kisnet_ytm import Client, AsyncClient, InvalidParameterError
# Instant range varies by OS; u64::MAX overflows when added to the current clock.
values = [0, -1, 1.5, float('nan'), float('inf'), True, '1', [], {}, 2**64, 2**64 - 1]
inputs = [('history', dict(base_dates=['2026-06-09'])), ('matrix', dict(base_date='2026-06-09',kind='10')), ('kinds',dict(base_date='2026-06-09'))]
async def run():
    async with AsyncClient() as client:
        for operation, payload in inputs:
            for value in values:
                try: await getattr(client, operation)(**payload, operation_timeout_seconds=value)
                except InvalidParameterError as error: assert error.details['parameter'] == 'operation_timeout_seconds'
                else: raise AssertionError(f'invalid timeout accepted: {value!r}')
        assert len((await client.kinds(operation_timeout_seconds=1)).kinds) == 8
if __ASYNC__:
    asyncio.run(run())
else:
    with Client() as client:
        for operation, payload in inputs:
            for value in values:
                try: getattr(client, operation)(**payload, operation_timeout_seconds=value)
                except InvalidParameterError as error: assert error.details['parameter'] == 'operation_timeout_seconds'
                else: raise AssertionError(f'invalid timeout accepted: {value!r}')
        assert len(client.kinds(operation_timeout_seconds=1).kinds) == 8
'''.replace('__ASYNC__', 'True' if surface == 'python-async' else 'False')
            result = subprocess.run([executable, '-I', '-c', script], env=source.environment(), capture_output=True, text=True, timeout=10)
            assert result.returncode == 0 and result.stderr == '', result.stderr
        assert not source.requests, 'invalid options must not start source I/O'
    print('PASS: ' + surface + ' timeout validation and old/default call forms before I/O')


def acceptance(surface, executable):
    validate_options(surface, executable)
    baseline, baseline_requests = None, None
    for scenario in ('baseline', 'recovery', 'initialization', 'body', 'exhaustion', 'timeout', 'guidance'):
        with tempfile.TemporaryDirectory(prefix='ytm-recovery-') as directory, Source(scenario) as source:
            output = Path(directory) / 'existing.xlsx'
            output.write_bytes(b'prior workbook')
            envelope = invoke(surface, executable, source, output)
            captures = source.requests
            if scenario in ('baseline', 'recovery', 'initialization', 'body'):
                assert envelope['ok'], envelope
                if scenario == 'baseline':
                    assert len(captures) == 18, len(captures)
                    baseline = envelope['result']
                    baseline_requests = [(path, body) for path, body, _ in captures]
                else:
                    assert envelope['result'] == baseline, (surface, scenario)
                    failed = 0 if scenario == 'initialization' else 16
                    assert len(captures) == 19, (scenario, len(captures))
                    assert captures[failed] == captures[failed + 1], 'replay changed request bytes/headers'
                    deduplicated = captures[:failed] + captures[failed + 1:]
                    assert [(path, body) for path, body, _ in deduplicated] == baseline_requests
            else:
                assert not envelope['ok'], envelope
                error = envelope['error']
                assert error['code'] == 'source_transport_error', error
                assert error['operationName'] == 'history', error
                assert error['actual']['requestedBaseDate'] == '2026-06-09', error
                assert error['actual']['kind']['code'] == '70', error
                assert error['attemptedDates'] == ['2026-06-09'], error
                assert error['retry'] == dict(attemptCount=3 if scenario == 'exhaustion' else 1,
                                             maxAttempts=3, sourceOperation='listYtmMatrix',
                                             stopReason='attempt_exhaustion' if scenario == 'exhaustion' else 'operation_deadline'), error
                if scenario == 'timeout':
                    assert error['cause'] == 'TimeoutError', error
                else:
                    assert error['actual']['sourceActual'] == 503, error
                physical = 19 if scenario == 'exhaustion' else 17
                if surface != 'cli':
                    assert envelope['reuseKinds'] == 8
                    physical += 1
                assert len(captures) == physical, (scenario, len(captures), physical)
            assert output.read_bytes() == b'prior workbook'
            assert list(Path(directory).iterdir()) == [output], 'staging residue'
        print('PASS: ' + surface + ' real HTTP ' + scenario + '; unchanged selection and all-or-error output')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--cli')
    parser.add_argument('--node')
    parser.add_argument('--python', action='store_true')
    args = parser.parse_args()
    if args.cli:
        acceptance('cli', str(Path(args.cli).resolve()))
    if args.node:
        acceptance('node', args.node)
    if args.python:
        acceptance('python-sync', sys.executable)
        acceptance('python-async', sys.executable)
    if not (args.cli or args.node or args.python):
        parser.error('select at least one public surface')


if __name__ == '__main__':
    main()
