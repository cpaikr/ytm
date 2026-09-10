#!/usr/bin/env python3
"""Public policy/progress acceptance through the existing guarded HTTP fixture."""
import argparse
import csv
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
Source = runpy.run_path(str(Path(__file__).with_name('retrieval-recovery.py')))['Source']
FIELDS = dict(scannedDateCount='scanned_date_count', completedQualifyingDateCount='completed_qualifying_date_count',
              discoveryCount='discovery_count', matrixLookupCount='matrix_lookup_count',
              physicalAttemptCount='physical_attempt_count', retryCount='retry_count',
              elapsedMs='elapsed_ms', waitingMs='waiting_ms', finished='finished')


def statistics(value):
    assert isinstance(value, dict), value
    assert set(value) in (set(FIELDS), set(FIELDS.values())), value
    normalized = value if 'elapsedMs' in value else {key: value[snake] for key, snake in FIELDS.items()}
    for key, number in normalized.items():
        if key == 'finished':
            assert type(number) is bool
        else:
            assert type(number) is int and number >= 0, (key, number)
    assert normalized['waitingMs'] <= normalized['elapsedMs'], normalized
    assert normalized['retryCount'] <= normalized['physicalAttemptCount'], normalized
    return normalized


def snapshots(values, final):
    previous = None
    for value in values:
        current = statistics(value)
        if previous:
            for key in FIELDS:
                assert current[key] >= previous[key], (key, previous, current)
        previous = current
    assert previous == statistics(final), (previous, final)
    assert previous['finished']


NODE = r'''
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {YtmClient, RetrievalProgress, serializeYtmError} from __PACKAGE__;
const client = new YtmClient();
const mode = process.env.YTM_CONTROLS_MODE;
const input = {count:2, endDate:'2026-06-09'};
const values = [];
const progress = new RetrievalProgress();
assert.equal(progress.snapshot(), null);
if (mode === 'validation') {
  for (const [method, input] of [['history',{baseDates:['2026-06-09']}], ['matrix',{baseDate:'2026-06-09',kind:'10'}], ['kinds',{baseDate:'2026-06-09'}]]) {
    for (const name of ['maxRetries','baseBackoffMs','maxBackoffMs','minRequestIntervalMs']) {
      for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, true, '1', null, [], {}, ...(name === 'maxRetries' ? [11] : [])]) {
        await assert.rejects(client[method](input, {[name]:value}), error => error.details.code === 'invalid_parameter');
      }
    }
    await assert.rejects(client[method](input, {baseBackoffMs:2,maxBackoffMs:1}), error => error.details.code === 'invalid_parameter');
    for (const value of [null, {}, () => {}, 1]) {
      await assert.rejects(client[method](input, {progress:value}), error => error.details.parameter === 'progress');
    }
  }
  const result = await client.kinds({}, {maxRetries:0,baseBackoffMs:0,maxBackoffMs:0,minRequestIntervalMs:0});
  assert.equal(result.statistics.physicalAttemptCount, 0);
  console.log(JSON.stringify({ok:true}));
} else if (mode === 'progress' || mode === 'more-retries') {
  let finished = false;
  const pending = client.history(input, {maxRetries:4,baseBackoffMs:0,maxBackoffMs:0,minRequestIntervalMs:50,progress})
    .finally(() => {finished = true;});
  await assert.rejects(client.kinds({}, {progress}), error => error.details.parameter === 'progress');
  while (!finished) {
    const snapshot = progress.snapshot();
    if (snapshot) values.push(snapshot);
    await delay(1);
  }
  const result = await pending;
  values.push(progress.snapshot());
  assert.deepEqual(progress.snapshot(), result.statistics);
  await assert.rejects(client.kinds({}, {progress}), error => error.details.parameter === 'progress');
  const frozen = progress.snapshot();
  await delay(5);
  assert.deepEqual(progress.snapshot(), frozen);
  assert.equal((await client.kinds()).statistics.physicalAttemptCount, 0);
  console.log(JSON.stringify({ok:true,statistics:result.statistics,snapshots:values,dates:result.requestedDates}));
} else if (mode === 'zero-retries') {
  const error = await client.history(input, {maxRetries:0}).then(() => {throw new Error('unexpected success');}, error => error);
  const details = serializeYtmError(error);
  assert.equal(details.retry.maxAttempts, 1);
  assert.equal(details.retry.stopReason, 'attempt_exhaustion');
  console.log(JSON.stringify({ok:false,error:details,statistics:details.statistics}));
} else {
  const controller = new AbortController();
  const pending = client.history(input, {minRequestIntervalMs:500,signal:controller.signal,progress});
  // Attach the rejection handler before cancelling to avoid an unhandled promise.
  const outcome = pending.then(() => {throw new Error('unexpected success');}, error => error);
  while ((progress.snapshot()?.matrixLookupCount ?? 0) < 1 || progress.snapshot().waitingMs === 0) await delay(1);
  controller.abort();
  const error = await outcome;
  assert.equal(error.name, 'AbortError');
  const details = serializeYtmError(error);
  assert.deepEqual({...details.statistics}, progress.snapshot());
  assert.equal((await client.kinds()).statistics.physicalAttemptCount, 0);
  console.log(JSON.stringify({ok:false,error:details,statistics:progress.snapshot()}));
}
'''

PYTHON = r'''
import asyncio, dataclasses, json, os, time
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor
from kisnet_ytm import Client, AsyncClient, RetrievalProgress, InvalidParameterError, YtmError

def thaw(value):
    if dataclasses.is_dataclass(value): return {field.name: thaw(getattr(value, field.name)) for field in dataclasses.fields(value)}
    if isinstance(value, Mapping): return {key: thaw(item) for key, item in value.items()}
    if isinstance(value, (tuple,list)): return [thaw(item) for item in value]
    return value

mode = os.environ['YTM_CONTROLS_MODE']
payload = dict(count=2,end_date='2026-06-09')
policy = dict(max_retries=4,base_backoff_ms=0,max_backoff_ms=0,min_request_interval_ms=50)
invalid = []
for name in ('max_retries','base_backoff_ms','max_backoff_ms','min_request_interval_ms'):
    for value in [-1,1.5,float('nan'),float('inf'),True,'1',[],{},2**64, *([11] if name == 'max_retries' else [])]: invalid.append({name:value})
invalid += [dict(base_backoff_ms=2,max_backoff_ms=1),dict(progress={}),dict(progress=lambda:None)]
inputs = [('history',dict(base_dates=['2026-06-09'])), ('matrix',dict(base_date='2026-06-09',kind='10')), ('kinds',dict(base_date='2026-06-09'))]

def sync_run():
    if mode == 'validation':
        with Client() as client:
            for method, data in inputs:
                for options in invalid:
                    try: getattr(client, method)(**data, **options)
                    except InvalidParameterError: pass
                    else: raise AssertionError(options)
            assert client.kinds(max_retries=0,base_backoff_ms=0,max_backoff_ms=0,min_request_interval_ms=0).statistics.physical_attempt_count == 0
        return dict(ok=True)
    progress = RetrievalProgress()
    assert progress.snapshot() is None
    values = []
    with Client() as client, ThreadPoolExecutor(max_workers=1) as pool:
        if mode in ('progress', 'more-retries'):
            pending = pool.submit(client.history, **payload, **policy, progress=progress)
            while progress.snapshot() is None: time.sleep(.001)
            try: client.kinds(progress=progress)
            except InvalidParameterError: pass
            else: raise AssertionError('concurrent handle reuse')
            while not pending.done():
                values.append(progress.snapshot())
                time.sleep(.001)
            result = pending.result()
            values.append(progress.snapshot())
            assert result.statistics == progress.snapshot()
            try: client.kinds(progress=progress)
            except InvalidParameterError: pass
            else: raise AssertionError('completed handle reuse')
            assert client.kinds().statistics.physical_attempt_count == 0
            output = dict(ok=True,statistics=result.statistics,snapshots=values,dates=result.requested_dates)
        elif mode == 'zero-retries':
            try: client.history(**payload, max_retries=0)
            except YtmError as error:
                assert error.details['retry']['maxAttempts'] == 1
                output = dict(ok=False,error=error.details,statistics=error.details['statistics'])
            else: raise AssertionError('unexpected success')
        else:
            pending = pool.submit(client.history, **payload, min_request_interval_ms=500, progress=progress)
            while (state := progress.snapshot()) is None or state.matrix_lookup_count < 1 or state.waiting_ms == 0: time.sleep(.001)
            client.close()
            try: pending.result()
            except YtmError as error:
                assert error.code == 'request_cancelled', error
                output = dict(ok=False,error=error.details,statistics=progress.snapshot())
            else: raise AssertionError('unexpected success')
    frozen = progress.snapshot()
    time.sleep(.005)
    assert progress.snapshot() == frozen, 'statistics survive client close unchanged'
    return output

async def async_run():
    async with AsyncClient() as client:
        if mode == 'validation':
            for method, data in inputs:
                for options in invalid:
                    try: await getattr(client, method)(**data, **options)
                    except InvalidParameterError: pass
                    else: raise AssertionError(options)
            assert (await client.kinds(max_retries=0,base_backoff_ms=0,max_backoff_ms=0,min_request_interval_ms=0)).statistics.physical_attempt_count == 0
            return dict(ok=True)
        progress = RetrievalProgress()
        assert progress.snapshot() is None
        if mode in ('progress', 'more-retries'):
            values = []
            pending = asyncio.create_task(client.history(**payload, **policy, progress=progress))
            await asyncio.sleep(0)
            try: await client.kinds(progress=progress)
            except InvalidParameterError: pass
            else: raise AssertionError('concurrent handle reuse')
            while not pending.done():
                if (state := progress.snapshot()) is not None: values.append(state)
                await asyncio.sleep(.001)
            result = await pending
            values.append(progress.snapshot())
            assert result.statistics == progress.snapshot()
            try: await client.kinds(progress=progress)
            except InvalidParameterError: pass
            else: raise AssertionError('completed handle reuse')
            assert (await client.kinds()).statistics.physical_attempt_count == 0
            output = dict(ok=True,statistics=result.statistics,snapshots=values,dates=result.requested_dates)
        elif mode == 'zero-retries':
            try: await client.history(**payload, max_retries=0)
            except YtmError as error:
                assert error.details['retry']['maxAttempts'] == 1
                output = dict(ok=False,error=error.details,statistics=error.details['statistics'])
            else: raise AssertionError('unexpected success')
        else:
            supplied = {} if mode == 'cancel-implicit' else dict(progress=progress)
            # Warm the client independently of the retrieval under test.
            await client.kinds()
            pending = asyncio.create_task(client.history(**payload,min_request_interval_ms=500,**supplied))
            if supplied:
                while (state := progress.snapshot()) is None or state.matrix_lookup_count < 1 or state.waiting_ms == 0: await asyncio.sleep(.001)
            else:
                await asyncio.sleep(.1)
            pending.cancel('caller cancellation identity')
            try: await pending
            except asyncio.CancelledError as error:
                assert error.args == ('caller cancellation identity',), error.args
                final = error.statistics
                if supplied: assert final == progress.snapshot()
                output = dict(ok=False,statistics=final)
            else: raise AssertionError('unexpected success')
            assert (await client.kinds()).statistics.physical_attempt_count == 0
    if mode != 'cancel-implicit':
        frozen = progress.snapshot()
        await asyncio.sleep(.005)
        assert progress.snapshot() == frozen
    return output

print(json.dumps(thaw(asyncio.run(async_run()) if __ASYNC__ else sync_run())))
'''


def sdk(surface, executable):
    for mode in ('validation', 'progress', 'more-retries', 'zero-retries', 'cancel', *(('cancel-implicit',) if surface == 'python-async' else ())):
        with Source('recovery' if mode == 'progress' else 'exhaustion' if mode in ('more-retries', 'zero-retries') else 'baseline') as source:
            if surface == 'node':
                script = NODE.replace('__PACKAGE__', json.dumps((ROOT / 'packages/node/dist/client.js').as_uri()))
                command = [executable, '--input-type=module', '-e', script]
            else:
                script = PYTHON.replace('__ASYNC__', 'True' if surface == 'python-async' else 'False')
                command = [executable, '-I', '-c', script]
            env = source.environment() | {'YTM_CONTROLS_MODE': mode}
            result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=20)
            assert result.returncode == 0 and result.stderr == '', (surface, mode, result.stderr, result.stdout)
            value = json.loads(result.stdout)
            if mode == 'validation':
                assert not source.requests
            elif mode in ('progress', 'more-retries'):
                stats = statistics(value['statistics'])
                assert stats['physicalAttemptCount'] == len(source.requests) == (19 if mode == 'progress' else 21), stats
                assert stats['retryCount'] == (1 if mode == 'progress' else 3) and stats['scannedDateCount'] == 2, stats
                assert stats['completedQualifyingDateCount'] == 2 and stats['waitingMs'] > 0, stats
                assert value['dates'] == ['2026-06-08', '2026-06-09']
                assert any(not state['finished'] for state in value['snapshots'])
                snapshots(value['snapshots'], value['statistics'])
            elif mode == 'zero-retries':
                stats = statistics(value['statistics'])
                assert stats['physicalAttemptCount'] == len(source.requests) == 17, stats
                assert stats['retryCount'] == 0 and stats['completedQualifyingDateCount'] == 1, stats
                assert stats['finished'] and value['error']['code'] == 'source_transport_error', value
            else:
                # A cancellation before core start has no retrieval counters.
                if source.requests or value['statistics'] is not None:
                    stats = statistics(value['statistics'])
                    assert stats['finished'] and stats['physicalAttemptCount'] == len(source.requests), stats
                    assert stats['retryCount'] == 0 and stats['completedQualifyingDateCount'] == 0, stats
                if mode == 'cancel':
                    assert len(source.requests) == 1
                    if 'error' in value:
                        assert statistics(value['error']['statistics']) == statistics(value['statistics'])
            print('PASS: ' + surface + ' bulk controls ' + mode)


def cli(executable):
    for flag in ('--max-retries', '--base-backoff-ms', '--max-backoff-ms', '--min-request-interval-ms'):
        with Source('baseline') as source:
            for value in ('-1', '1.5', 'NaN', 'Infinity', 'true', '18446744073709551616', *(('11',) if flag == '--max-retries' else ())):
                result = subprocess.run([executable, 'kinds', '--base-date', '2026-06-09', flag, value], env=source.environment(), capture_output=True, text=True, timeout=5)
                assert result.returncode == 2 and json.loads(result.stdout)['error']['code'] == 'invalid_parameter', result
            assert not source.requests
    for mode in ('json', 'csv', 'failure'):
        with tempfile.TemporaryDirectory(prefix='ytm-controls-') as directory, Source('exhaustion' if mode == 'failure' else 'baseline') as source:
            destination = Path(directory) / 'existing.xlsx'
            destination.write_bytes(b'prior workbook')
            args = [executable, 'history', '--end-date', '2026-06-09', '--count', '2', '--progress', '--max-retries', '0', '--base-backoff-ms', '0', '--max-backoff-ms', '0', '--min-request-interval-ms', '50']
            args += ['--format', 'xlsx', '--output', str(destination), '--overwrite'] if mode == 'failure' else ['--format', mode]
            result = subprocess.run(args, env=source.environment(), capture_output=True, text=True, timeout=10)
            assert result.returncode == (1 if mode == 'failure' else 0), result.stderr
            values = []
            for line in result.stderr.splitlines():
                assert line.startswith('YTM retrieval: '), line
                values.append(json.loads(line.removeprefix('YTM retrieval: ')))
            assert values and values[-1]['finished'], result.stderr
            stats = statistics(values[-1])
            snapshots(values, values[-1])
            assert stats['physicalAttemptCount'] == len(source.requests) == (17 if mode == 'failure' else 18)
            assert stats['retryCount'] == 0 and stats['completedQualifyingDateCount'] == (1 if mode == 'failure' else 2)
            if mode == 'csv':
                rows = list(csv.DictReader(io.StringIO(result.stdout)))
                assert len(rows) == 16 and all(row['3M'] == '-0.5' for row in rows), rows[:1]
            else:
                envelope = json.loads(result.stdout)
                assert statistics(envelope['error' if mode == 'failure' else 'result']['statistics']) == stats
            assert destination.read_bytes() == b'prior workbook'
            print('PASS: CLI bulk controls ' + mode)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--cli')
    parser.add_argument('--node')
    parser.add_argument('--python', action='store_true')
    args = parser.parse_args()
    if args.cli: cli(str(Path(args.cli).resolve()))
    if args.node: sdk('node', args.node)
    if args.python:
        sdk('python-sync', sys.executable)
        sdk('python-async', sys.executable)
    if not (args.cli or args.node or args.python): parser.error('select a public surface')


if __name__ == '__main__':
    main()
