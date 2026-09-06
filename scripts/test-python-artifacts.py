"""Offline fault injection at wheel integrity and complete-set boundaries."""
import base64
import csv
import importlib.util
import io
import json
from pathlib import Path
import struct
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('artifacts', Path(__file__).with_name('python-artifacts.py'))
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)


def candidate(directory, target, change=None):
    dist = f'kisnet_ytm-{a.VERSION}.dist-info'
    data = {f'kisnet_ytm/{p.name}': p.read_bytes() for p in (a.PACKAGE / 'src/kisnet_ytm').iterdir() if p.is_file()}
    native = bytearray(1024)
    if target['system'] == 'Linux':
        native[:6] = b'\x7fELF\x02\x01'
        struct.pack_into('<HH', native, 16, 3, 62 if target['arch'] == 'x64' else 183)
        struct.pack_into('<Q', native, 40, 64)
        struct.pack_into('<HH', native, 58, 64, 3)
        struct.pack_into('<IIQQQQIIQQ', native, 128, 0, 3, 0, 0, 320, 32, 0, 0, 0, 0)
        struct.pack_into('<IIQQQQIIQQ', native, 192, 0, 6, 0, 0, 400, 32, 1, 0, 0, 0)
        native[256:266] = b'GLIBC_2.28'
        native[321:331] = b'libc.so.6\0'
        struct.pack_into('<QQ', native, 400, 1, 1)
    elif target['system'] == 'Darwin':
        native[:4] = b'\xcf\xfa\xed\xfe'
        struct.pack_into('<I', native, 4, 0x100000c)
        struct.pack_into('<II', native, 12, 6, 1)
        struct.pack_into('<IIIIII', native, 32, 0x32, 24, 1, 0x000b0000, 0, 0)
    else:
        native[:2] = b'MZ'
        struct.pack_into('<I', native, 60, 64)
        native[64:68] = b'PE\0\0'
        struct.pack_into('<HH', native, 68, 0x8664, 1)
        struct.pack_into('<HH', native, 84, 240, 0x2000)
        struct.pack_into('<H', native, 88, 0x20b)
        struct.pack_into('<II', native, 208, 0x1000, 40)
        struct.pack_into('<8sIIIIIIHHI', native, 328, b'.rdata', 512, 0x1000, 512, 512, 0, 0, 0, 0, 0)
        struct.pack_into('<I', native, 524, 0x1080)
        native[640:652] = b'python3.dll\0'
    data['kisnet_ytm/_native.' + ('pyd' if target['system'] == 'Windows' else 'abi3.so')] = bytes(native)
    data[f'{dist}/METADATA'] = f'Metadata-Version: 2.4\nName: kisnet-ytm\nVersion: {a.VERSION}\nRequires-Python: >=3.11\n'.encode()
    data[f'{dist}/WHEEL'] = f'Wheel-Version: 1.0\nRoot-Is-Purelib: false\nTag: cp311-abi3-{target["platform"]}\n'.encode()
    for name in ('LICENSE.md', 'THIRD_PARTY_LICENSES.html'):
        data[f'{dist}/licenses/{name}'] = (a.ROOT / name).read_bytes()
    if change:
        change(data)
    record = io.StringIO()
    writer = csv.writer(record, lineterminator='\n')
    for name, value in data.items():
        writer.writerow([name, 'sha256=' + base64.urlsafe_b64encode(a.hashlib.sha256(value).digest()).decode().rstrip('='), str(len(value))])
    writer.writerow([f'{dist}/RECORD', '', ''])
    data[f'{dist}/RECORD'] = record.getvalue().encode()
    path = directory / a.wheel_name(target)
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, value in data.items():
            archive.writestr(name, value)
    return path


class Integrity(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.target = a.POLICY['targets'][0]

    def tearDown(self):
        self.temporary.cleanup()

    def test_complete_set_and_immutable_source(self):
        for target in a.POLICY['targets']:
            path = candidate(self.directory, target)
            record = a.inspect(path, target) | {'sourceCommit': a.source_sha(), 'version': a.VERSION}
            (self.directory / f'{target["key"]}.json').write_text(json.dumps(record))
        self.assertEqual(len(a.validate_set(self.directory)), 4)
        evidence = self.directory / f'{self.target["key"]}.json'
        record = json.loads(evidence.read_text())
        for key, value in [('sourceCommit', '0' * 40), ('sha256', '0' * 64), ('version', '9.9.9')]:
            evidence.write_text(json.dumps(record | {key: value}))
            with self.assertRaises(ValueError):
                a.validate_set(self.directory)
        evidence.write_text(json.dumps(record))
        (self.directory / 'extra.whl').write_bytes(b'extra')
        with self.assertRaises(ValueError):
            a.validate_set(self.directory)
        (self.directory / 'extra.whl').unlink()
        (self.directory / a.wheel_name(self.target)).unlink()
        with self.assertRaises(FileNotFoundError):
            a.validate_set(self.directory)

    def test_wheel_boundary_faults(self):
        def native_change(data, old, new):
            key = next(n for n in data if n.endswith('.so'))
            data[key] = data[key].replace(old, new)
        mutations = [
            lambda d: d.pop('kisnet_ytm/py.typed'),
            lambda d: d.update({'kisnet_ytm/_native.pyi': b'stale typing'}),
            lambda d: d.update({'../outside': b'bad'}),
            lambda d: d.update({'kisnet_ytm/extra.so': b'extra native'}),
            lambda d: native_change(d, b'GLIBC_2.28', b'GLIBC_2.29'),
            lambda d: native_change(d, b'\x7fELF', b'wrong'),
            lambda d: d.update({f'kisnet_ytm-{a.VERSION}.dist-info/licenses/LICENSE.md': b'stale license'}),
            lambda d: d.update({f'kisnet_ytm-{a.VERSION}.dist-info/METADATA': b'Name: wrong\nVersion: 0.2.0\n'}),
        ]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                path = candidate(self.directory, self.target, mutate)
                with self.assertRaises(ValueError):
                    a.inspect(path, self.target)

    def test_unshipped_native_dependencies(self):
        for target in a.POLICY['targets']:
            def mutate(data):
                key = next(n for n in data if n.endswith(('.so', '.pyd')))
                native = data[key]
                if target['system'] == 'Windows':
                    native = native.replace(b'python3.dll', b'private.dll')
                elif target['system'] == 'Linux':
                    native = native.replace(b'libc.so.6', b'evil.so.6')
                else:
                    native = bytearray(native)
                    struct.pack_into('<I', native, 44, 0x000c0000)
                    native = bytes(native)
                data[key] = native
            with self.subTest(target=target['key']):
                path = candidate(self.directory, target, mutate)
                with self.assertRaises(ValueError):
                    a.inspect(path, target)

    def test_additional_ordinary_and_delay_dlls(self):
        target = next(t for t in a.POLICY['targets'] if t['system'] == 'Windows')
        for delayed in (False, True):
            def mutate(data):
                key = next(n for n in data if n.endswith('.pyd'))
                native = bytearray(data[key])
                native[656:668] = b'private.dll\0'
                if delayed:
                    struct.pack_into('<II', native, 304, 0x1100, 64)
                    struct.pack_into('<II', native, 768, 1, 0x1090)
                else:
                    struct.pack_into('<I', native, 212, 60)
                    struct.pack_into('<I', native, 544, 0x1090)
                data[key] = bytes(native)
            with self.subTest(delayed=delayed):
                path = candidate(self.directory, target, mutate)
                with self.assertRaisesRegex(ValueError, 'Non-system PE dependencies'):
                    a.inspect(path, target)

    def test_corrupt_record_and_duplicate_members(self):
        path = candidate(self.directory, self.target)
        with zipfile.ZipFile(path, 'a') as archive:
            archive.writestr('kisnet_ytm/py.typed', b'changed')
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            a.inspect(path, self.target)
        path = candidate(self.directory, self.target)
        with zipfile.ZipFile(path) as archive:
            data = {n: archive.read(n) for n in archive.namelist()}
        data['kisnet_ytm/py.typed'] = b'changed'
        with zipfile.ZipFile(path, 'w') as archive:
            for name, value in data.items():
                archive.writestr(name, value)
        with self.assertRaises(ValueError):
            a.inspect(path, self.target)


if __name__ == '__main__':
    unittest.main()
