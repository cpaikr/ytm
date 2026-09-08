"""Typed offline public usage, run from an installed wheel outside the checkout."""
import asyncio
from kisnet_ytm import AsyncClient, Client, ClientStateError, InvalidParameterError, KindsResult


def sync_usage() -> None:
    with Client() as client:
        catalog: KindsResult = client.kinds()
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
        catalog: KindsResult = await client.kinds()
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
