"""Local Python foundation gate; portable release matrix is owned separately."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import tomllib
import venv

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = ROOT / "packages/python"


def run(*args, cwd=ROOT, env=None):
    subprocess.run([str(arg) for arg in args], cwd=cwd, env=env, check=True)


def main():
    if sys.version_info < (3, 11):
        raise SystemExit("CPython 3.11+ required; set PYO3_PYTHON to its executable")
    run(sys.executable, ROOT / "scripts/test-python-artifacts.py")
    with tempfile.TemporaryDirectory(prefix="ytm-python-validate-") as temporary:
        work = Path(temporary)
        venv.EnvBuilder(with_pip=True).create(work / "build")
        scripts = "Scripts" if os.name == "nt" else "bin"
        executable = "python.exe" if os.name == "nt" else "python"
        python = work / "build" / scripts / executable
        metadata = tomllib.loads((PACKAGE / "pyproject.toml").read_text())
        run(python, "-m", "pip", "install", *metadata["build-system"]["requires"])
        build_env = os.environ | {"PYO3_PYTHON": str(python)}
        for fixture in ((True,) if "--fixtures-only" in sys.argv else (True, False)):
            wheel_dir = work / ("fixtures" if fixture else "release")
            args = ["--features", "judge-fixtures"] if fixture else ["--release"]
            run(python, "-m", "maturin", "build", "--locked", "--interpreter", python,
                "--out", wheel_dir, *args, cwd=PACKAGE, env=build_env)
            wheels = list(wheel_dir.glob("*.whl"))
            assert len(wheels) == 1, wheels
            consumer = work / ("fixture-consumer" if fixture else "release-consumer")
            venv.EnvBuilder(with_pip=True).create(consumer)
            interpreter = consumer / scripts / executable
            run(interpreter, "-m", "pip", "install", "--no-index", "--no-deps", wheels[0])
            clean = os.environ | {"PATH": str(consumer / scripts), "PYTHONPATH": ""}
            if fixture:
                run(interpreter, "-I", PACKAGE / "tests/behavior.py", ROOT / "contracts/kisnet", cwd=work, env=clean)
                run(interpreter, "-I", ROOT / "judge/retrieval-recovery.py", "--python", cwd=work, env=clean)
                run(interpreter, "-I", ROOT / "judge/bulk-retrieval-controls.py", "--python", cwd=work, env=clean)
            else:
                # Release code must ignore all fixture routing and panic injection variables.
                clean |= {"YTM_JUDGE_FIXTURE": "invalid fixture configuration", "YTM_PYTHON_JUDGE_PANIC": "1", "YTM_JUDGE_HTTP_ORIGIN": "invalid origin"}
                shutil.copyfile(PACKAGE / "tests/consumer.py", work / "consumer.py")
                run(interpreter, "-I", work / "consumer.py", cwd=work, env=clean)
                run(interpreter, "-m", "pip", "install", "mypy==2.3.1")
                run(interpreter, "-I", "-m", "mypy", "--strict", "-p", "kisnet_ytm", cwd=work, env=clean)
                run(interpreter, "-I", "-m", "mypy", "--strict", "consumer.py", cwd=work, env=clean)
    print("Python foundation validation passed")


if __name__ == "__main__":
    main()
