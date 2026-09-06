"""Process-isolated installed-wheel tests. Every source request uses Rust fixtures."""
import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor


def child(scenario, mode):
    from kisnet_ytm import (
        AsyncClient, Client, ClientStateError, DefectError, InvalidParameterError,
        RequestCancelledError, SourceDataUnavailableError, SourceFormatError,
        SourceProtocolError, SourceTransportError,
    )
    capture = Path(os.environ["YTM_JUDGE_CAPTURE_PATH"])

    def requests():
        try:
            return json.loads(capture.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return []

    async def started():
        async with asyncio.timeout(3):
            while not requests():
                await asyncio.sleep(0.005)

    async def exercise():
        client = AsyncClient() if mode == "async" else Client()
        async def call(operation="matrix", **kwargs):
            if operation == "matrix":
                kwargs = dict(base_date="2026-06-08", kind=10) | kwargs
            value = getattr(client, operation)(**kwargs)
            return await value if mode == "async" else value

        async def close():
            before = time.monotonic()
            if mode == "async":
                await client.aclose()
            else:
                client.close()
            assert time.monotonic() - before < 2, "close did not promptly drain work"

        try:
            if scenario in ("success", "missing", "fallback"):
                kwargs = {"fallback": "previous-available", "lookback_days": 2} if scenario == "fallback" else {}
                result = await call(**kwargs)
                assert result.kind.code == "10"
                assert result.tenors[0] == "3M"
                assert result.rows and result.source.request.parameters.cbo_ytm_sort == "10"
                assert result.requested_base_date == "2026-06-08"
                if scenario == "fallback":
                    assert result.base_date == "2026-06-07"
                    assert result.date_resolution.attempted_dates == ("2026-06-08", "2026-06-07")
                    assert result.date_resolution.used_fallback
                if scenario == "missing":
                    assert None in result.rows[0].yields.values()
                try:
                    result.rows[0].yields["3M"] = 99
                    raise AssertionError("mutable result")
                except TypeError:
                    pass
            elif scenario == "catalog":
                result = await call("kinds")
                assert result.base_date is None and result.kinds[0].code == "10"
                assert not requests()
            elif scenario == "discovery":
                result = await call("kinds", base_date="2026-06-08")
                assert result.base_date == "2026-06-08" and result.kinds[0].code == "10"
                assert len(requests()) == 1
            elif scenario == "invalid":
                for kwargs in (
                    {"base_date": "2026-02-30"}, {"base_date": True}, {"kind": True},
                    {"kind": ""}, {"kind": 10**5000}, {"fallback": "bad"}, {"fallback": None},
                    {"lookback_days": 2}, {"fallback": "previous-available", "lookback_days": 32},
                    {"fallback": "previous-available", "lookback_days": True},
                ):
                    try:
                        await call(**kwargs)
                        raise AssertionError("accepted invalid input")
                    except InvalidParameterError as error:
                        assert error.code == "invalid_parameter"
                assert not requests()
            elif scenario in ("transport", "protocol", "format", "unavailable", "panic"):
                expected = dict(transport=SourceTransportError, protocol=SourceProtocolError,
                                format=SourceFormatError, unavailable=SourceDataUnavailableError,
                                panic=DefectError)[scenario]
                try:
                    await call()
                    raise AssertionError("expected boundary failure")
                except expected as error:
                    assert "injected" not in str(error)
                    assert "retryable" in error.details and "recoveryHint" in error.details
                    if scenario == "panic":
                        assert error.code == "internal_error"
                    try:
                        error.details["code"] = "changed"
                        raise AssertionError("mutable error metadata")
                    except TypeError:
                        pass
                if scenario == "panic":
                    del os.environ["YTM_PYTHON_JUDGE_PANIC"]
                    assert (await call("kinds")).kinds
            elif scenario in ("cancel", "close_active", "cancel_close"):
                if mode == "sync":
                    with ThreadPoolExecutor() as pool:
                        active = pool.submit(client.matrix, base_date="2026-06-08", kind=10)
                        await started()  # also proves run_sync releases the GIL
                        before = time.monotonic()
                        client.close()
                        assert time.monotonic() - before < 2, "close did not promptly drain work"
                        try:
                            active.result(timeout=2)
                            raise AssertionError("expected close cancellation")
                        except RequestCancelledError:
                            pass
                else:
                    task = asyncio.create_task(call())
                    await started()
                    if scenario == "cancel":
                        task.cancel()
                        try:
                            await task
                            raise AssertionError("expected task cancellation")
                        except asyncio.CancelledError:
                            pass
                        # Same client remains usable after per-call cancellation.
                        assert (await asyncio.wait_for(call("kinds"), timeout=2)).kinds
                    else:
                        queued = asyncio.create_task(call())
                        await asyncio.sleep(0.02)
                        cleanup = asyncio.create_task(close())
                        await asyncio.sleep(0)
                        if scenario == "cancel_close":
                            cleanup.cancel()
                            try:
                                await cleanup
                            except asyncio.CancelledError:
                                pass
                            await close()
                        else:
                            await cleanup
                        for active in (task, queued):
                            try:
                                await active
                                raise AssertionError("expected close cancellation")
                            except RequestCancelledError:
                                pass
                        assert len(requests()) == 1
            else:
                raise AssertionError(scenario)
        finally:
            await close()
        await close()
        try:
            await call("kinds")
            raise AssertionError("call after close succeeded")
        except ClientStateError as error:
            assert error.code == "client_closed"

    asyncio.run(exercise())
    if mode == "async":
        client = AsyncClient()
        asyncio.run(client.aclose())
        try:
            asyncio.run(client.aclose())
            raise AssertionError("cross-loop reuse succeeded")
        except ClientStateError as error:
            assert error.code == "wrong_event_loop"
    else:
        with Client() as client:
            assert client.kinds().kinds


def main():
    if len(sys.argv) == 4 and sys.argv[1] == "--child":
        child(sys.argv[2], sys.argv[3])
        return
    fixtures = Path(sys.argv[1]).resolve()
    scenarios = {
        "catalog": [], "invalid": [], "discovery": [{"fixture": "init-success.xml"}],
        "success": [{"fixture": "matrix-success.xml"}],
        "missing": [{"fixture": "matrix-missing-values.xml"}],
        "fallback": [{"fixture": "matrix-unavailable.xml"}, {"fixture": "matrix-success.xml"}],
        "unavailable": [{"fixture": "matrix-unavailable.xml"}],
        "transport": [{"transportError": "fixture"}],
        "protocol": [{"fixture": "protocol-error.xml"}],
        "format": [{"fixture": "malformed-response.xml"}],
        "panic": [], "cancel": [{"waitForCancellation": True}],
        "close_active": [{"waitForCancellation": True}],
        "cancel_close": [{"waitForCancellation": True}],
    }
    for name in ("success", "missing", "fallback", "unavailable", "transport", "protocol", "format"):
        scenarios[name].insert(0, {"fixture": "init-success.xml"})
    scenarios["fallback"].insert(2, {"fixture": "init-success.xml"})
    count = 0
    with tempfile.TemporaryDirectory(prefix="ytm-python-behavior-") as temporary:
        for mode in ("sync", "async"):
            for scenario, steps in scenarios.items():
                if mode == "sync" and scenario in ("cancel", "cancel_close"):
                    continue
                capture = Path(temporary) / f"{mode}-{scenario}.json"
                env = os.environ | {
                    "YTM_JUDGE_FIXTURE": json.dumps(dict(fixtureDirectory=str(fixtures), steps=steps)),
                    "YTM_JUDGE_CAPTURE_PATH": str(capture),
                }
                env.pop("YTM_PYTHON_JUDGE_PANIC", None)
                if scenario == "panic":
                    env["YTM_PYTHON_JUDGE_PANIC"] = "1"
                result = subprocess.run([sys.executable, "-I", str(Path(__file__).resolve()), "--child", scenario, mode],
                                        cwd=temporary, env=env, text=True, capture_output=True, timeout=15)
                if result.returncode:
                    raise AssertionError(f"{mode}/{scenario}:\n{result.stdout}\n{result.stderr}")
                assert "panicked at" not in result.stderr and "injected binding defect" not in result.stderr, result.stderr
                count += 1
                print(f"PASS {mode}/{scenario}", flush=True)
    print(f"Python installed-wheel behavior: {count} isolated processes passed")


if __name__ == "__main__":
    main()
