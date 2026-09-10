"""Typed offline public usage, run from an installed wheel outside the checkout."""
import asyncio
from kisnet_ytm import AsyncClient, Client, ClientStateError, InvalidParameterError, KindsResult, RetrievalProgress, RetrievalStatistics


def sync_usage() -> None:
    with Client() as client:
        progress = RetrievalProgress()
        catalog: KindsResult = client.kinds(max_retries=4, base_backoff_ms=0, max_backoff_ms=0,
                                           min_request_interval_ms=1, progress=progress)
        statistics: RetrievalStatistics | None = catalog.statistics
        assert statistics is not None and statistics.finished
        assert statistics.physical_attempt_count == 0
        assert progress.snapshot() == statistics
        assert catalog.kinds[0].code == "10"
        try:
            client.history(count=1, end_date="invalid")
        except InvalidParameterError:
            pass
        else:
            raise AssertionError("invalid history accepted")
        try:
            client.matrix(base_date="invalid", kind="국채")
        except InvalidParameterError as error:
            assert error.code == "invalid_parameter"
        else:
            raise AssertionError("invalid date accepted")
    client.close()
    try:
        client.kinds()
    except ClientStateError:
        pass
    else:
        raise AssertionError("closed client accepted a call")


async def async_usage() -> None:
    async with AsyncClient() as client:
        progress = RetrievalProgress()
        catalog: KindsResult = await client.kinds(max_retries=0, base_backoff_ms=0, max_backoff_ms=0,
                                                 min_request_interval_ms=0, progress=progress)
        statistics: RetrievalStatistics | None = catalog.statistics
        assert statistics is not None and statistics.finished
        assert progress.snapshot() == statistics
        assert catalog.kinds[0].code == "10"
        try:
            await client.history(count=1, end_date="invalid")
        except InvalidParameterError:
            pass
        else:
            raise AssertionError("invalid history accepted")
        try:
            await client.matrix(base_date="invalid", kind=10)
        except InvalidParameterError:
            pass
        else:
            raise AssertionError("invalid date accepted")
    await client.aclose()


sync_usage()
asyncio.run(async_usage())
