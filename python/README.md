# `local_decider` — Jey's loopback decision service

Scores Jey's structured questions against a **pinned quantized checkpoint on CPU** and
answers over `127.0.0.1`. The TypeScript side (`packages/provider-local`) is the only
intended client.

This service is new work in this project. [SemIf](https://github.com/TheoLeeCJ/SemIf)
provides the scoring backend (`semif_phase1.llamacpp_backend`) and does **not** expose an
HTTP API of its own; wrapping it in a resident service is what this directory adds.

## Setup (the commands that were actually run)

```sh
uv venv --python 3.12 .venv                                     # python/.venv
uv pip install --python .venv/Scripts/python.exe -e "<semif-checkout>[llamacpp]"
.venv/Scripts/python.exe -m local_decider.download_weights      # ~3.0 GB, verifies sha256
```

`download_weights` is the only thing that touches the network for weights, and it is a
separate explicit command: a running service never downloads. It verifies the file
against `models.lock.json` and deletes it if the digest does not match.

## Run

```sh
JEY_LOCAL_TOKEN="$(openssl rand -hex 24)" \
  .venv/Scripts/python.exe -m local_decider.service --port 8732
```

No token, no start. The bind address must be a loopback literal (`127.x.x.x` or `::1`);
`localhost` is not accepted, because a guard that depends on the resolver can be moved by
`/etc/hosts`.

| Variable | Default | Meaning |
|---|---|---|
| `JEY_LOCAL_TOKEN` | — | Bearer token. Required, and never the cloud provider's key. |
| `JEY_MODEL_LOCK` | `python/models.lock.json` | Which pinned model this service may be. |
| `JEY_LOCAL_HOST` / `JEY_LOCAL_PORT` | `127.0.0.1` / `8732` | Bind. `--port 0` picks an ephemeral port and logs the real one. |
| `JEY_LOCAL_MAX_INPUT_BYTES` | `32768` | Body bound. The effective limit is this **and** the request's own budget, whichever is stricter. |
| `JEY_LOCAL_MAX_DEADLINE_MS` | `60000` | Ceiling on a caller-supplied deadline, matching `limits.deadlineMs.maximum` in the config schema. |
| `JEY_LOCAL_QUEUE_DEPTH` | `4` | Extra requests before `429 QUEUE_FULL`. |
| `JEY_LOCAL_SLOW_REQUEST_S` | `10` | Socket read timeout. Bounds reading a body, not the model. |

Endpoints: `GET /health/live` (no token, loads nothing), `GET /health/ready`,
`GET /v1/capabilities`, `POST /v1/decide`. Everything except `live` needs the token.

## What the answers are

`probability.origin` is `native-logits` and `calibration` is `uncalibrated`: values are the
softmax over the declared answer slots of the last-position logits, i.e. a conditional
option score. They are **not** decision confidence, and `policy.ts` will not let an
uncalibrated score deny a call the host allowed. `usage.outputTokens` is always `0` because
nothing is generated. `egress.occurred` is `false` for a loopback call.

## Latency, measured on this host

Loading takes ~19 s once. Three execution-gate questions over one shared state took
**2.5 s** cold and ~0.5 s per additional question with the state prefix cached
(`artifacts/local_inference_e2e.json`). The config default `limits.deadlineMs` is 1500 ms,
which is a cloud-provider number: **a local CPU backend needs it raised**, or every enforce
call fails closed with `TIMEOUT`.

## Testing

```sh
.venv/Scripts/python.exe -m unittest discover -s tests -t .                    # protocol, no model
JEY_RUN_INFERENCE=1 .venv/Scripts/python.exe -m unittest tests.test_inference   # real weights
```

The inference tests skip unless the weights verify **and** `JEY_RUN_INFERENCE=1`. A skip is
reported as a skip. The end-to-end run that starts this service from the TypeScript client
is `pnpm --filter jey-provider-local test:e2e:local` with `JEY_E2E_LOCAL=1`.

## Limits worth stating

* Loopback plus a token is not a security boundary against a process running as the same
  user. Real isolation needs an OS user or container boundary.
* Cancellation is `discard-only`: a decode in flight cannot be interrupted, so the service
  stops serving the result and counts it as discarded rather than claiming it stopped.
* `pip install` of this package has not been exercised. The verified layout is a checkout
  plus `python/.venv` with SemIf installed editable.
