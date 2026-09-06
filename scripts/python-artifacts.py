"""Build, inspect, aggregate, and consume immutable mixed-wheel candidates."""
import argparse
import base64
import csv
from email.parser import BytesParser
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import shutil
import struct
import subprocess
import sys
import sysconfig
import tempfile
import tomllib
import venv
import zipfile

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = ROOT / 'packages/python'
POLICY = json.loads((ROOT / 'python-targets.json').read_text())
VERSION = (ROOT / 'VERSION').read_text().strip()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def run(*args, **kwargs):
    subprocess.run([str(a) for a in args], check=True, **kwargs)


def source_sha():
    actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    expected = os.environ.get('RELEASE_SHA', os.environ.get('SOURCE_COMMIT', actual))
    require(re.fullmatch('[0-9a-f]{40}', expected) and expected == actual, 'Candidate source differs from checkout')
    return actual


def wheel_name(target):
    return f'kisnet_ytm-{VERSION}-cp311-abi3-{target["platform"]}.whl'


def host(target):
    require(platform.system() == target['system'] and platform.machine().lower() == target['machine'].lower(), 'Target must run on its native host')
    require(platform.python_implementation() == 'CPython' and not sysconfig.get_config_var('Py_GIL_DISABLED'), 'Conventional CPython required')
    require(f'{sys.version_info.major}.{sys.version_info.minor}' in POLICY['pythonVersions'], 'Unvalidated interpreter')


def cstring(data, offset):
    require(0 <= offset < len(data), 'Native string offset out of bounds')
    end = data.find(b'\0', offset)
    require(end >= 0, 'Unterminated native dependency')
    return data[offset:end].decode('ascii')


def native_identity(data, target):
    if target['system'] == 'Linux':
        require(data[:6] == b'\x7fELF\x02\x01', 'Expected little-endian ELF64')
        require(struct.unpack_from('<H', data, 16)[0] == 3, 'Expected ELF shared library')
        require(struct.unpack_from('<H', data, 18)[0] == (62 if target['arch'] == 'x64' else 183), 'Wrong ELF architecture')
        versions = [(int(a), int(b)) for a, b in re.findall(rb'GLIBC_(\d+)\.(\d+)', data)]
        require(versions and max(versions) <= (2, 28), 'Native extension exceeds glibc 2.28')
        section_offset = struct.unpack_from('<Q', data, 40)[0]
        size, count = struct.unpack_from('<HH', data, 58)
        require(size == 64 and count > 0 and section_offset + size * count <= len(data), 'Invalid ELF sections')
        sections = [struct.unpack_from('<IIQQQQIIQQ', data, section_offset + size * i) for i in range(count)]
        libraries = []
        for section in sections:
            if section[1] != 6:
                continue
            require(section[6] < count and section[4] + section[5] <= len(data), 'Invalid ELF dynamic table')
            strings = sections[section[6]]
            require(strings[1] == 3 and strings[4] + strings[5] <= len(data), 'Invalid ELF string table')
            for offset in range(section[4], section[4] + section[5], 16):
                tag, value = struct.unpack_from('<QQ', data, offset)
                if tag == 1:
                    require(value < strings[5], 'Invalid ELF dependency offset')
                    libraries.append(cstring(data, strings[4] + value))
        allowed = {'libc.so.6', 'libm.so.6', 'libdl.so.2', 'libpthread.so.0', 'librt.so.1', 'libutil.so.1', 'libgcc_s.so.1', 'ld-linux-x86-64.so.2', 'ld-linux-aarch64.so.1'}
        require(libraries and set(libraries) <= allowed, f'Non-system ELF dependencies: {libraries}')
    elif target['system'] == 'Darwin':
        require(data[:4] == b'\xcf\xfa\xed\xfe' and struct.unpack_from('<I', data, 4)[0] == 0x100000c, 'Expected ARM64 Mach-O')
        require(struct.unpack_from('<I', data, 12)[0] == 6, 'Expected Mach-O dynamic library')
        offset = 32
        deployment = False
        for _ in range(struct.unpack_from('<I', data, 16)[0]):
            command, size = struct.unpack_from('<II', data, offset)
            require(size >= 8 and offset + size <= len(data), 'Invalid Mach-O load command')
            if command in (12, 0x80000018, 0x8000001f, 0x20, 0x80000023):
                start = offset + struct.unpack_from('<I', data, offset + 8)[0]
                dependency = cstring(data, start)
                require(dependency.startswith(('/usr/lib/', '/System/Library/')), f'Non-system native dependency: {dependency}')
            if command == 0x32:
                deployment = True
                require(struct.unpack_from('<I', data, offset + 8)[0] == 1 and struct.unpack_from('<I', data, offset + 12)[0] <= 0x000b0000, 'macOS deployment floor exceeds 11.0')
            offset += size
        require(deployment, 'Missing macOS deployment identity')
    else:
        require(data[:2] == b'MZ', 'Expected PE extension')
        offset = struct.unpack_from('<I', data, 60)[0]
        require(data[offset:offset+4] == b'PE\0\0' and struct.unpack_from('<H', data, offset + 4)[0] == 0x8664, 'Expected x64 PE')
        count = struct.unpack_from('<H', data, offset + 6)[0]
        optional_size, flags = struct.unpack_from('<HH', data, offset + 20)
        optional = offset + 24
        require(flags & 0x2000 and struct.unpack_from('<H', data, optional)[0] == 0x20b, 'Expected PE32+ DLL')
        require(optional_size >= 224 and optional + optional_size + count * 40 <= len(data), 'Invalid PE headers')
        sections = [struct.unpack_from('<8sIIIIIIHHI', data, optional + optional_size + i * 40) for i in range(count)]
        def rva(address):
            for section in sections:
                if section[2] <= address < section[2] + section[3]:
                    result = section[4] + address - section[2]
                    require(result < len(data), 'PE RVA outside file')
                    return result
            raise ValueError('Unmapped PE dependency RVA')
        libraries = []
        for index, stride, name_offset in [(1, 20, 12), (13, 32, 4)]:
            address, size = struct.unpack_from('<II', data, optional + 112 + index * 8)
            if not address:
                continue
            start = rva(address)
            require(size >= stride and start + size <= len(data), 'Invalid PE import table')
            terminated = False
            for entry in range(start, start + size, stride):
                if data[entry:entry + stride] == bytes(stride):
                    terminated = True
                    break
                if index == 13:
                    require(struct.unpack_from('<I', data, entry)[0] == 1, 'Unsupported delay-import addressing')
                name_address = struct.unpack_from('<I', data, entry + name_offset)[0]
                libraries.append(cstring(data, rva(name_address)).lower())
            require(terminated, 'Unterminated PE import table')
        allowed = {'python3.dll', 'kernel32.dll', 'ntdll.dll', 'advapi32.dll', 'bcrypt.dll', 'bcryptprimitives.dll', 'crypt32.dll', 'iphlpapi.dll', 'ws2_32.dll', 'userenv.dll', 'secur32.dll', 'shell32.dll', 'ole32.dll', 'oleaut32.dll', 'user32.dll', 'gdi32.dll', 'ucrtbase.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'}
        require('python3.dll' in libraries, 'Windows abi3 must import python3.dll')
        require(all(name in allowed or re.fullmatch(r'api-ms-win-(?:crt|core|security)-[a-z0-9-]+\.dll', name) for name in libraries), f'Non-system PE dependencies: {libraries}')


def inspect(path, target):
    require(path.name == wheel_name(target), 'Wrong wheel filename/version/target')
    with zipfile.ZipFile(path) as wheel:
        names = wheel.namelist()
        require(len(names) == len(set(names)), 'Duplicate wheel entries')
        require(all(not n.startswith('/') and '..' not in Path(n).parts and '\\' not in n for n in names), 'Unsafe wheel path')
        dist = f'kisnet_ytm-{VERSION}.dist-info'
        native = [n for n in names if n.startswith('kisnet_ytm/_native.') and n.endswith(('.so', '.pyd'))]
        require(len(native) == 1, 'Expected exactly one native extension')
        expected = {f'kisnet_ytm/{p.name}' for p in (PACKAGE / 'src/kisnet_ytm').iterdir() if p.is_file()}
        expected |= {native[0], *(f'{dist}/{n}' for n in ('METADATA', 'WHEEL', 'RECORD', 'licenses/LICENSE.md', 'licenses/THIRD_PARTY_LICENSES.html'))}
        require(set(names) == expected, f'Unexpected/missing wheel entries: {set(names) ^ expected}')
        for path_source in (PACKAGE / 'src/kisnet_ytm').iterdir():
            if path_source.is_file():
                require(wheel.read(f'kisnet_ytm/{path_source.name}') == path_source.read_bytes(), f'Stale Python source/typing: {path_source.name}')
        for license_name in ('LICENSE.md', 'THIRD_PARTY_LICENSES.html'):
            require(wheel.read(f'{dist}/licenses/{license_name}') == (ROOT / license_name).read_bytes(), 'Stale legal notices')
        metadata = BytesParser().parsebytes(wheel.read(f'{dist}/METADATA'))
        require(metadata['Name'] == 'kisnet-ytm' and metadata['Version'] == VERSION and metadata['Requires-Python'] == '>=3.11', 'Wrong package metadata')
        require(not metadata.get_all('Requires-Dist'), 'Runtime dependencies are not part of this wheel contract')
        tags = BytesParser().parsebytes(wheel.read(f'{dist}/WHEEL'))
        require(tags.get_all('Tag') == [f'cp311-abi3-{target["platform"]}'] and tags['Root-Is-Purelib'] == 'false', 'Wrong ABI/platform identity')
        records = list(csv.reader(io.StringIO(wheel.read(f'{dist}/RECORD').decode())))
        require(len(records) == len(names) and {r[0] for r in records} == set(names), 'Incomplete RECORD')
        for name, checksum, size in records:
            data = wheel.read(name)
            if name == f'{dist}/RECORD':
                require(checksum == size == '', 'RECORD must not hash itself')
            else:
                encoded = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip('=')
                require(checksum == 'sha256=' + encoded and size == str(len(data)), f'RECORD mismatch: {name}')
        data = wheel.read(native[0])
        native_identity(data, target)
        return {'filename': path.name, 'sha256': digest(path.read_bytes()), 'nativeSha256': digest(data), 'target': target['key']}


def build(directory, target):
    host(target)
    require(sys.version_info[:2] == (3, 11), 'Build with CPython 3.11')
    directory.mkdir(parents=True, exist_ok=True)
    require(not list(directory.iterdir()), 'Build output must be empty')
    sha = source_sha()
    epoch = subprocess.check_output(['git', 'show', '-s', '--format=%ct', sha], cwd=ROOT, text=True).strip()
    environment = os.environ | {'SOURCE_DATE_EPOCH': epoch, 'PYO3_PYTHON': sys.executable, 'CARGO_INCREMENTAL': '0', 'MACOSX_DEPLOYMENT_TARGET': '11.0'}
    # This build has its own target directory, so no fixture/debug output can be reused.
    previous = None
    for _ in range(2):
        with tempfile.TemporaryDirectory(prefix='ytm-python-release-') as temporary:
            environment['CARGO_TARGET_DIR'] = str(Path(temporary) / 'target')
            environment.pop('CARGO_ENCODED_RUSTFLAGS', None)
            environment['RUSTFLAGS'] = f'--remap-path-prefix={ROOT}=/ytm --remap-path-prefix={temporary}=/build'
            if target['system'] == 'Windows':
                environment['RUSTFLAGS'] += ' -C link-arg=/Brepro'
            arguments = ['--zig', '--compatibility', 'manylinux_2_28', '--auditwheel', 'check'] if target['system'] == 'Linux' else []
            run(sys.executable, '-m', 'maturin', 'build', '--release', '--locked', '--target', target['rust'], '--interpreter', sys.executable, '--out', directory, *arguments, cwd=PACKAGE, env=environment)
            require([p.name for p in directory.iterdir()] == [wheel_name(target)], 'Build produced unexpected artifacts')
            result = inspect(directory / wheel_name(target), target)
            extension = '_native.dll' if target['system'] == 'Windows' else 'lib_native.' + ('dylib' if target['system'] == 'Darwin' else 'so')
            built = Path(temporary) / 'target' / target['rust'] / 'release' / extension
            require(digest(built.read_bytes()) == result['nativeSha256'], 'Wheel does not contain the fresh native build')
        if previous is not None:
            require(result == previous, 'Independent fresh builds produced different wheel bytes')
        previous = result
    result |= {'version': VERSION, 'sourceCommit': sha}
    (directory / f'{target["key"]}.json').write_text(json.dumps(result, sort_keys=True, indent=2) + '\n')


def validate_set(directory):
    sha = source_sha()
    expected = set()
    records = []
    for target in POLICY['targets']:
        name = wheel_name(target)
        evidence = f'{target["key"]}.json'
        expected |= {name, evidence}
        record = json.loads((directory / evidence).read_text())
        actual = inspect(directory / name, target) | {'version': VERSION, 'sourceCommit': sha}
        require(record == actual, f'Wheel checksum/source evidence mismatch: {name}')
        records.append(record)
    require({p.name for p in directory.iterdir()} == expected, 'Incomplete or extra Python candidates')
    return records


def consume(directory, target):
    host(target)
    records = validate_set(directory)
    selected = next(r for r in records if r['target'] == target['key'])
    wheel = directory / selected['filename']
    with tempfile.TemporaryDirectory(prefix='ytm-python-consumer-') as temporary:
        work = Path(temporary)
        venv.EnvBuilder(with_pip=True).create(work / 'venv')
        scripts = work / 'venv' / ('Scripts' if os.name == 'nt' else 'bin')
        python = scripts / ('python.exe' if os.name == 'nt' else 'python')
        run(python, '-m', 'pip', 'install', '--no-index', '--no-deps', '--only-binary=:all:', wheel, cwd=work)
        run(python, '-m', 'pip', 'install', f'mypy=={POLICY["mypy"]}', cwd=work)
        shutil.copyfile(PACKAGE / 'tests/consumer.py', work / 'consumer.py')
        environment = os.environ | {'PATH': str(scripts), 'PYTHONPATH': '', 'MYPYPATH': '', 'YTM_JUDGE_FIXTURE': 'invalid fixture configuration', 'YTM_PYTHON_JUDGE_PANIC': '1'}
        run(python, '-I', work / 'consumer.py', cwd=work, env=environment)
        run(python, '-I', '-c', 'import hashlib, shutil, kisnet_ytm._native as n; from pathlib import Path; import sys; assert shutil.which("cargo") is None; assert n.__version__ == sys.argv[2]; assert not any(p.startswith(sys.argv[3]) for p in sys.path); assert hashlib.sha256(Path(n.__file__).read_bytes()).hexdigest() == sys.argv[1]', selected['nativeSha256'], VERSION, ROOT, cwd=work, env=environment)
        run(python, '-I', '-m', 'mypy', '--strict', '-p', 'kisnet_ytm', cwd=work, env=environment)
        run(python, '-I', '-m', 'mypy', '--strict', 'consumer.py', cwd=work, env=environment)
    require(digest(wheel.read_bytes()) == selected['sha256'], 'Consumer changed candidate bytes')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('matrix', 'build', 'validate', 'consume'))
    parser.add_argument('directory', nargs='?', type=Path)
    parser.add_argument('--target', choices=[t['key'] for t in POLICY['targets']])
    parser.add_argument('--consumers', action='store_true')
    args = parser.parse_args()
    if args.action == 'matrix':
        rows = [t | {'python': p} for t in POLICY['targets'] for p in POLICY['pythonVersions']] if args.consumers else POLICY['targets']
        print(json.dumps({'include': rows}, separators=(',', ':')))
        return
    require(args.directory is not None, 'Artifact directory required')
    directory = args.directory.resolve()
    if args.action == 'validate':
        validate_set(directory)
    else:
        require(args.target is not None, 'Target required')
        target = next(t for t in POLICY['targets'] if t['key'] == args.target)
        (build if args.action == 'build' else consume)(directory, target)
    print(f'Python {args.action} passed')


if __name__ == '__main__':
    main()
