#!/usr/bin/env python3
"""Black-box history export and POSIX Ctrl-C/terminal acceptance (no network)."""
import argparse
import errno
import json
import os
from pathlib import Path
import signal
import select
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
INIT = "/rateInfo/ytmMatrixMobileInitList.do"
MATRIX = "/rateInfo/ytmMatrixMobileList.do"
CODES = [str(n) for n in range(10, 81, 10)]
KEYS = "m3 m6 m9 y1 y15a y2 y25 y3 y5 y7 y10 y15 y20 y30 y50".split()


def xml(rows):
    return ('<Root xmlns="http://www.nexacroplatform.com/platform/dataset">'
            '<Parameters><Parameter id="ErrorCode">0</Parameter></Parameters>'
            f'<Dataset id="output1"><Rows>{rows}</Rows></Dataset></Root>')


CATALOG = xml('<Row><Col id="divCode">10</Col><Col id="divName">국채</Col></Row>')
ROW = xml('<Row><Col id="pricingGroupCode">001</Col>'
          '<Col id="pricingGroupName">=한글</Col>' + ''.join(
              f'<Col id="{key}">{value}</Col>' for key, value in
              zip(KEYS, ['-0.500', '0.000'] + ['-'] * 13)) + '</Row>')


def environment(steps, capture):
    env = {k: v for k, v in os.environ.items() if not k.startswith('YTM_JUDGE_')}
    env['YTM_JUDGE_FIXTURE'] = json.dumps({'fixtureDirectory': str(ROOT), 'steps': steps})
    env['YTM_JUDGE_CAPTURE_PATH'] = str(capture)
    return env


def command(binary, output):
    return [str(binary), 'history', '--start-date', '2026-06-08', '--end-date',
            '2026-06-09', '--format=xlsx', '--output', str(output), '--overwrite']


def read_captures(path):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def cells(capture):
    return {node.attrib.get('id'): node.text for node in ET.fromstring(capture['body']).iter()
            if node.tag.rsplit('}', 1)[-1] == 'Col'}


def export(binary, output):
    steps = []
    expected = []
    for date in ['20260608', '20260609']:
        steps.append({'path': INIT, 'body': CATALOG})
        expected.append((INIT, date, None))
        for code in CODES:
            steps.append({'path': MATRIX, 'body': xml('') if (date, code) == ('20260609', '80') else ROW})
            expected.append((MATRIX, date, code))
    with tempfile.TemporaryDirectory(prefix='ytm-history-export-') as directory:
        capture = Path(directory) / 'requests.json'
        result = subprocess.run(command(binary, output), env=environment(steps, capture),
                                capture_output=True, text=True, timeout=15, check=False)
        assert result.returncode == 0, (result.stdout, result.stderr)
        assert result.stderr == '', result.stderr
        receipt = json.loads(result.stdout)['result']
        assert (receipt['availableCount'], receipt['unavailableCount'], receipt['dataRowCount']) == (15, 1, 15), receipt
        observed = read_captures(capture)
        assert len(observed) == len(expected), observed
        for request, (path, date, code) in zip(observed, expected):
            values = cells(request)
            assert request['url'].endswith(path) and values['calBaseDt'] == date, request
            if code is not None:
                assert values['cboYtmSort'] == code, request
        assert output.read_bytes().startswith(b'PK\x03\x04')
        print('PASS: synthetic two-date workbook, 15 available / 1 unavailable; 18 exact requests; redirected stderr empty')


def cancel(binary, terminal):
    # Only stderr is a terminal: JSON stdout must remain machine-readable.
    import pty
    with tempfile.TemporaryDirectory(prefix='ytm-history-cancel-') as directory:
        directory = Path(directory)
        output = directory / 'history.xlsx'
        output.write_bytes(b'prior workbook')
        capture = directory / 'requests.json'
        steps = [{'path': INIT, 'body': CATALOG}, {'path': MATRIX, 'waitForCancellation': True}]
        # Keep the parent slave open until draining: macOS can discard unread
        # terminal output when the last slave closes at child exit.
        master, slave = pty.openpty() if terminal else (None, None)
        process = subprocess.Popen(command(binary, output), cwd=directory,
                                   env=environment(steps, capture), stdout=subprocess.PIPE,
                                   stderr=slave if terminal else subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 4
            while len(read_captures(capture)) < 2:
                assert process.poll() is None, 'CLI exited before delayed matrix request'
                assert time.monotonic() < deadline, 'Fixture capture deadline exceeded'
                time.sleep(0.01)
            process.send_signal(signal.SIGINT)
            stdout, stderr = process.communicate(timeout=3)
            if terminal:
                os.set_blocking(master, False)
                chunks = []
                while True:
                    try:
                        chunk = os.read(master, 4096)
                    except BlockingIOError:
                        break
                    except OSError as error:
                        if error.errno == errno.EIO:
                            break
                        raise
                    if not chunk:
                        break
                    chunks.append(chunk)
                stderr = b''.join(chunks).decode()
            assert process.returncode > 0, process.returncode
            envelope = json.loads(stdout)
            error = envelope['error']
            assert error['code'] == 'source_transport_error', envelope
            assert error['operationName'] == 'history', envelope
            assert error['actual']['kind']['code'] == '10', envelope
            assert 'AbortError' in stdout, envelope
            if terminal:
                assert 'YTM history: 1 dated discoveries, 0 date/category fetches started' in stderr, stderr
                assert len(stderr.splitlines()) == 1, stderr
            else:
                assert stderr == '', stderr
            assert output.read_bytes() == b'prior workbook'
            assert {p.name for p in directory.iterdir()} == {'history.xlsx', 'requests.json'}
            assert len(read_captures(capture)) == 2
            print(f'PASS: Ctrl-C ({"terminal" if terminal else "redirected"} stderr), JSON cancellation envelope, preserved destination, no staging files')
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()
            if slave is not None:
                os.close(slave)
            if master is not None:
                os.close(master)


def interrupt_blocked_output(binary):
    with tempfile.TemporaryDirectory(prefix='ytm-history-blocked-output-') as directory:
        directory = Path(directory)
        capture = directory / 'requests.json'
        rows = ''.join(
            f'<Row><Col id="pricingGroupCode">{index:03}</Col>'
            f'<Col id="pricingGroupName">group {index}</Col>' + ''.join(
                f'<Col id="{key}">1.000</Col>' for key in KEYS) + '</Row>'
            for index in range(300))
        fixture = directory / 'rows.xml'
        fixture.write_text(xml(rows))
        steps = [{'path': INIT, 'body': CATALOG}] + [
            {'path': MATRIX, 'fixture': str(fixture)} for _ in CODES]
        process = subprocess.Popen(
            [str(binary), 'history', '--start-date', '2026-06-08',
             '--end-date', '2026-06-08', '--format=json'],
            env=environment(steps, capture), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            # Readability proves output has started. Keep the >1 MB result
            # unread so writing cannot finish within the OS pipe capacity.
            assert select.select([process.stdout], [], [], 10)[0], 'No history output'
            assert len(read_captures(capture)) == 9
            process.send_signal(signal.SIGINT)
            assert process.wait(timeout=3) == 130, process.returncode
            print('PASS: first Ctrl-C during blocked history output exits 130')
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate()


def interrupt_blocked_cancellation(binary):
    with tempfile.TemporaryDirectory(prefix='ytm-history-blocked-cancel-') as directory:
        capture = Path(directory) / 'requests.json'
        steps = [{'path': INIT, 'body': CATALOG}, {'path': MATRIX, 'waitForCancellation': True}]
        reader, writer = os.pipe()
        try:
            os.set_blocking(writer, False)
            try:
                while True:
                    os.write(writer, b'x' * 4096)
            except BlockingIOError:
                pass
            os.set_blocking(writer, True)
            process = subprocess.Popen(
                [str(binary), 'history', '--start-date', '2026-06-08',
                 '--end-date', '2026-06-08', '--format=json'],
                env=environment(steps, capture), stdout=writer, stderr=subprocess.PIPE)
        finally:
            os.close(writer)
        try:
            deadline = time.monotonic() + 4
            while len(read_captures(capture)) < 2:
                assert process.poll() is None, 'CLI exited before delayed matrix request'
                assert time.monotonic() < deadline, 'Fixture capture deadline exceeded'
                time.sleep(0.01)
            process.send_signal(signal.SIGINT)
            # The first interrupt must allow graceful cancellation, whose
            # small error envelope cannot fit in the prefilled output pipe.
            try:
                process.wait(timeout=0.5)
                raise AssertionError(f'First Ctrl-C bypassed graceful cancellation: {process.returncode}')
            except subprocess.TimeoutExpired:
                pass
            process.send_signal(signal.SIGINT)
            assert process.wait(timeout=3) == 130, process.returncode
            print('PASS: second Ctrl-C during blocked cancellation output exits 130')
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate()
            os.close(reader)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cli-bin', type=Path, default=ROOT / 'target' / 'debug' / ('ytm.exe' if os.name == 'nt' else 'ytm'))
    parser.add_argument('--output', type=Path, help='Retain synthetic workbook for application QA')
    args = parser.parse_args()
    binary = args.cli_bin.resolve()
    with tempfile.TemporaryDirectory(prefix='ytm-history-lifecycle-') as directory:
        export(binary, args.output.resolve() if args.output else Path(directory) / 'history.xlsx')
    if os.name == 'nt':
        print('SKIP: POSIX PTY/SIGINT cases on Windows; portable export case passed')
    else:
        cancel(binary, False)
        cancel(binary, True)
        interrupt_blocked_output(binary)
        interrupt_blocked_cancellation(binary)


if __name__ == '__main__':
    main()
