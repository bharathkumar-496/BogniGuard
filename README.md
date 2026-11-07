# BogniGuard

A local app that adds a faint protective pattern to your photos, so that
Stable Diffusion edits of them give themselves away. Everything runs on your own
computer, and the server only listens on `127.0.0.1`.

BogniGuard is a new interface built on [PhotoGuard](https://github.com/MadryLab/photoguard)
by Salman, Khaddaj, Leclerc, Ilyas and Madry ([paper](https://arxiv.org/abs/2302.06588)).
The attack is theirs, and their original demo code is in `demo/`. Their notebooks and
example photos stay in the original repository. See the [original repository](https://github.com/MadryLab/photoguard) and [LICENSE](LICENSE) (MIT).

## Run it

```bash
cd ~/BogniGuard
.venv/bin/python run.py
```

Then open http://127.0.0.1:7878

To set up from scratch (Python 3.12 and [uv](https://docs.astral.sh/uv/)):

```bash
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements-app.txt
```

The first launch fetches the model (about 2.1 GB) from Hugging Face if it isn't cached:
`stable-diffusion-v1-5/stable-diffusion-inpainting`, under the CreativeML OpenRAIL-M licence.

## What's where

| Path | Purpose |
| --- | --- |
| `bogniguard/engine.py` | The PGD encoder attack and the inpainting test, for MPS, CUDA or CPU |
| `bogniguard/server.py` | FastAPI server with live progress over server-sent events |
| `bogniguard/public.py` | Preset scenes for the public version |
| `bogniguard/webapp.py`, `modal_app.py` | Experimental cloud version. Never run live: it needs a paid GPU |
| `site/` | The 3D explanation website (Three.js, static) |
| `web/` | The animated interface (plain HTML, CSS and JS, no build step) |
| `web/brand/` | Guard mark, `bogniguard` wordmark lockups and favicon as SVG |

## Brand

BogniGuard is a Bognitive product. Type follows the Bognitive kit (Plus Jakarta Sans and
Geist Mono), as do Ink, Cobalt and Electric, and the motion language: gather, connect,
settle. The Guard mark is its own mark, not a change to the Bognitive mark: four flowing
lobes stacked into a shield.

## Limits

BogniGuard raises the cost of malicious editing. It is not a guarantee.

- The pattern is visible up close, as a faint scaly texture on smooth areas.
- Painted-area mode held up better than whole-photo mode in our inpainting tests.
- It targets the Stable Diffusion 1.x encoder. Other AI editors may not be affected.
- JPEG compression, resizing, screenshots and deliberate cleanup can weaken or remove it.
- It works at 512 x 512, so photos are center-cropped.
- It does nothing for copies of a photo that are already online.
