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


async def cancelled_bridge_failure(timing):
    from kisnet_ytm import AsyncClient, DefectError, RetrievalProgress

    class FailingBridge:
        """Inject only bridge completion failure after real offline retrieval."""
        def __init__(self, native):
            self.native = native
            self.ready = asyncio.Event()
            self.release = asyncio.Event()
            self.owner = None
            self.future = None

        def run_async(self, *args):
            async def complete():
                await self.native.run_async(*args)
                self.ready.set()
                if timing == "completed":
                    self.owner.cancel("original cancellation")
                elif timing == "during-drain":
                    await self.release.wait()
                raise RuntimeError("injected bridge failure")
            self.future = asyncio.create_task(complete())
            return self.future

        def close_async(self):
            return self.native.close_async()

    client = AsyncClient()
    bridge = FailingBridge(client._native)
    client._native = bridge
    progress = RetrievalProgress()
    task = asyncio.create_task(client.kinds(progress=progress))
    bridge.owner = task
    if timing == "during-drain":
        await bridge.ready.wait()
        task.cancel("original cancellation")
        await asyncio.sleep(0)
        assert not task.done() and not bridge.future.done(), "cancellation must drain native work"
        task.cancel("repeated cancellation")
        await asyncio.sleep(0)
        assert not task.done() and not bridge.future.done()
        bridge.release.set()
    try:
        await task
        raise AssertionError("injected bridge failure was ignored")
    except asyncio.CancelledError as error:
        assert timing != "uncancelled"
        assert error.args == ("original cancellation",)
        assert task.cancelled()
        assert error.statistics == progress.snapshot()
        assert error.statistics.finished and error.statistics.physical_attempt_count == 0
    except DefectError:
        assert timing == "uncancelled", "native failure replaced caller cancellation"
        assert not task.cancelled()
    finally:
        await client.aclose()
    assert bridge.future.done()
    assert not bridge.future._log_traceback, "native exception was not consumed"


def child(scenario, mode):
    from kisnet_ytm import (
        AsyncClient, Client, ClientStateError, DefectError, InvalidParameterError, InsufficientHistoryError,
        RequestCancelledError, SourceDataUnavailableError, SourceFormatError,
        SourceProtocolError, SourceTransportError,
    )
    count_lifecycle = scenario.startswith("count-")
    if count_lifecycle:
        scenario = "history-" + scenario.removeprefix("count-")
    history_lifecycle = scenario.startswith("history-")
    if history_lifecycle:
        scenario = scenario.removeprefix("history-")
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
        async def call(operation=None, **kwargs):
            operation = operation or ("history" if history_lifecycle else "matrix")
            if operation == "history" and not kwargs:
                kwargs = dict(count=1, end_date="20260608") if count_lifecycle else dict(base_dates=["20260608"])
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
            if scenario.startswith("bridge-"):
                await cancelled_bridge_failure(scenario.removeprefix("bridge-"))
                assert requests() == []
            elif scenario == "count":
                from dataclasses import FrozenInstanceError
                result = await call("history", count=2, end_date="20260610")
                assert result.requested_dates == ("2026-06-08", "2026-06-09")
                assert result.available_count == 16 and len(requests()) == 19
                assert result.count_selection.count == 2
                assert result.count_selection.end_date == "2026-06-10"
                assert result.count_selection.start_date is None
                assert result.count_selection.scanned_start_date == "2026-06-08"
                assert result.count_selection.scanned_date_count == 3
                assert all(not entry.matrix.date_resolution.used_fallback for entry in result.entries)
                try:
                    result.count_selection.count = 3
                    raise AssertionError("mutable count metadata")
                except FrozenInstanceError:
                    pass
            elif scenario == "count_shortfall":
                try:
                    await call("history", count=2, end_date="20260609", start_date="20260608")
                    raise AssertionError("short count succeeded")
                except InsufficientHistoryError as error:
                    assert error.code == "insufficient_history"
                    assert error.details["actual"]["foundCount"] == 1
                    assert error.details["actual"]["scannedDateCount"] == 2
                    assert len(requests()) == 10
            elif scenario == "count_invalid":
                for kwargs in [dict(count=n,end_date="20260608") for n in (0,-1,2001,True,1.5,"1",10**5000)] + [
                    dict(count=1), dict(count=1,end_date="20260608",base_dates=["20260608"]),
                    dict(count=1,end_date="20260608",fallback="previous-available"),
                    dict(count=1,end_date="20260608",lookback_days=1),
                    dict(count=1,end_date="20260608",start_date="20260609"),
                ]:
                    try:
                        await call("history", **kwargs)
                        raise AssertionError("invalid count accepted")
                    except InvalidParameterError:
                        pass
                assert not requests()
            elif scenario in ("history", "history_empty", "history_fallback"):
                from dataclasses import FrozenInstanceError
                kwargs = dict(base_dates=["20260608", "2026.06.09", "2026-06-08"])
                if scenario == "history_fallback":
                    kwargs |= dict(fallback="previous-available", lookback_days=2)
                result = await call("history", **kwargs)
                assert result.requested_dates == ("2026-06-08", "2026-06-09")
                assert len(result.entries) == 16
                assert result.available_count == (0 if scenario == "history_empty" else 16)
                assert result.unavailable_count == (16 if scenario == "history_empty" else 0)
                assert isinstance(result.entries, tuple)
                try:
                    result.available_count = 0
                    raise AssertionError("mutable history")
                except FrozenInstanceError:
                    pass
                if scenario != "history_empty":
                    assert result.entries[7].matrix.kind.code == "80"
                    assert result.entries[0].matrix.rows
                    try:
                        result.entries[0].matrix.rows[0].raw["m3"] = "0"
                        raise AssertionError("mutable nested history")
                    except TypeError:
                        pass
                if scenario == "history_fallback":
                    assert result.entries[8].matrix.base_date == "2026-06-08"
                    assert result.entries[8].matrix.date_resolution.attempted_dates == ("2026-06-09", "2026-06-08")
                assert len(requests()) == (2 if scenario == "history_empty" else 18)
            elif scenario in ("success", "missing", "fallback"):
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
            elif scenario == "history_invalid":
                for days in (0, -1, 32, 256, 10**5000):
                    try:
                        await call("history", base_dates=["20260608"],
                                   fallback="previous-available", lookback_days=days)
                        raise AssertionError("accepted invalid history lookback")
                    except InvalidParameterError as error:
                        assert error.code == "invalid_parameter"
                        assert error.details["parameter"] == "lookback_days"
                assert not requests()
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
                        if history_lifecycle:
                            kwargs = dict(count=1, end_date="20260608") if count_lifecycle else dict(base_dates=["20260608"])
                            active = pool.submit(client.history, **kwargs)
                        else:
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
        "bridge-completed": [], "bridge-during-drain": [], "bridge-uncancelled": [],
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
    init = {"fixture": "init-success.xml"}
    full = [init] + [{"fixture": "matrix-success.xml"}] * 8
    scenarios |= {
        "count": [{"fixture":"matrix-unavailable.xml"}] + full * 2,
        "count_shortfall": [{"fixture":"matrix-unavailable.xml"}] + full,
        "count_invalid": [],
        "count-cancel": [{"waitForCancellation": True}],
        "count-close_active": [{"waitForCancellation": True}],
        "count-cancel_close": [{"waitForCancellation": True}],
        "history_invalid": [],
        "history": full * 2,
        "history_empty": [{"fixture": "matrix-unavailable.xml"}] * 2,
        "history_fallback": full + [init] + [{"fixture": "matrix-unavailable.xml"}] * 8,
        "history-cancel": [{"waitForCancellation": True}],
        "history-close_active": [{"waitForCancellation": True}],
        "history-cancel_close": [{"waitForCancellation": True}],
    }
    count = 0
    with tempfile.TemporaryDirectory(prefix="ytm-python-behavior-") as temporary:
        for mode in ("sync", "async"):
            for scenario, steps in scenarios.items():
                if mode == "sync" and scenario.startswith("bridge-"):
                    continue
                if mode == "sync" and scenario in ("cancel", "cancel_close", "history-cancel", "history-cancel_close", "count-cancel", "count-cancel_close"):
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
