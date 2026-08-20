# Public-surface judge

The judge compares two built or installed `@sjunepark/ytm` package roots. It
resolves only the package-declared `bin` and `./toolset` exports and invokes
each in a separate Node process. For the archived JavaScript baseline, fixture
transport is installed outside the package through a Node preload; no source
module, parser, request builder, or Python private API is imported.

The Rust candidate will use a compile-time-gated fixture transport implemented
below the Node-API boundary. The judge passes the same fixture sequence through
process environment, while the public JavaScript API remains unchanged. That
transport is built only into judge artifacts, never release artifacts; pure
Rust conformance tests separately prove its prepared requests match OpenAPI.
This is the only deterministic way to exercise malformed and unavailable
responses after the public `context.fetch` seam is removed.

`scenarios.json` is the human-reviewed observable-behavior inventory. The
executable foundation covers both public surfaces, every shared XML fixture,
generated XML/transport boundaries, fallback, machine output, and package
shape. Clean native consumer installation and the approved kind-80 divergences
become mandatory when the candidate native packages exist.

Run the archived implementation against itself while building the foundation:

```sh
bun run judge
```

Compare two distinct package roots:

```sh
node judge/run.mjs --baseline-root /path/to/legacy/package --candidate-root /path/to/candidate/package
```

Prove judge sensitivity against a disposable legacy mutation:

```sh
bun run judge:broken
```

The mutation proof changes missing yields from `null` to zero in a temporary
copy and succeeds only when the judge rejects that candidate. The copy is
deleted automatically and never becomes product or fixture authority.
