"""Protection engine.

The attack is the PhotoGuard encoder attack from demo/app.py (Salman et al.,
arXiv:2302.06588): projected gradient descent that pushes the image's VAE
latent toward the latent of a flat gray image, within a small L-infinity bound.

Differences from the original demo: it runs on MPS / CUDA / CPU instead of
CUDA only, uses float32 (half precision is unreliable for this on MPS), uses a
locally generated gray target instead of fetching one from a third-party URL,
and reports progress through a callback.
"""
from __future__ import annotations

import gc
import threading
from dataclasses import dataclass
from typing import Callable, Optional

import numpy as np
import torch
from PIL import Image, ImageOps

MODEL_ID = "stable-diffusion-v1-5/stable-diffusion-inpainting"
SIZE = 512


@dataclass(frozen=True)
class Strength:
    eps: float  # L-infinity bound in the model's [-1, 1] range
    step: float
    iters: int


# "balanced" is the paper demo's setting (eps=0.12, step=0.01, 200 iterations).
STRENGTHS = {
    "light": Strength(0.06, 0.01, 100),
    "balanced": Strength(0.12, 0.01, 200),
    "maximum": Strength(0.20, 0.015, 300),
}


def pick_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def fit(image: Image.Image) -> Image.Image:
    return ImageOps.fit(ImageOps.exif_transpose(image).convert("RGB"), (SIZE, SIZE))


def to_tensor(image: Image.Image) -> torch.Tensor:
    arr = np.asarray(image.convert("RGB"), dtype=np.float32) / 127.5 - 1.0
    return torch.from_numpy(arr).permute(2, 0, 1)[None]


def to_image(tensor: torch.Tensor) -> Image.Image:
    arr = ((tensor[0].detach().float().cpu() / 2 + 0.5).clamp(0, 1) * 255)
    return Image.fromarray(arr.round().byte().permute(1, 2, 0).numpy())


def noise_view(original: torch.Tensor, adv: torch.Tensor, eps: float) -> Image.Image:
    """The added pattern, amplified so it can be seen. Not the protected image."""
    diff = ((adv - original)[0].detach().float().cpu() / max(eps, 1e-6)).clamp(-1, 1)
    arr = ((diff + 1) * 127.5).round().byte().permute(1, 2, 0).numpy()
    return Image.fromarray(arr)


def psnr(a: Image.Image, b: Image.Image) -> float:
    x = np.asarray(a, dtype=np.float64)
    y = np.asarray(b, dtype=np.float64)
    mse = float(np.mean((x - y) ** 2))
    return 99.0 if mse == 0 else 10 * np.log10(255**2 / mse)


class Cancelled(Exception):
    pass


class Blocked(Exception):
    """The safety filter rejected a generated image."""


class Engine:
    """Loads weights lazily, and serialises GPU work behind one lock."""

    def __init__(self, safety: bool = False) -> None:
        self.safety = safety  # public deployments keep the safety filter on
        self.device = pick_device()
        self.dtype = torch.float32
        self.lock = threading.Lock()
        self._pipe = None

    @property
    def pipe(self):
        if self._pipe is None:
            from diffusers import StableDiffusionInpaintPipeline

            options = {} if self.safety else {
                "safety_checker": None,
                "feature_extractor": None,
                "requires_safety_checker": False,
            }
            pipe = StableDiffusionInpaintPipeline.from_pretrained(
                MODEL_ID, variant="fp16", torch_dtype=self.dtype, **options
            )
            pipe.set_progress_bar_config(disable=True)
            self._pipe = pipe.to(self.device)
        return self._pipe

    def _flush(self) -> None:
        gc.collect()
        if self.device == "mps":
            torch.mps.empty_cache()
        elif self.device == "cuda":
            torch.cuda.empty_cache()

    def protect(
        self,
        image: Image.Image,
        keep_mask: Optional[Image.Image],
        strength: str,
        on_step: Callable[[dict], None],
        should_stop: Callable[[], bool],
        preview_every: int = 10,
    ) -> dict:
        """Immunise `image`.

        keep_mask: white where the pattern is applied. None protects everything.
        The perturbation is confined to that region, so the rest of the image
        stays byte-identical to the input.
        """
        cfg = STRENGTHS[strength]
        image = fit(image)
        with self.lock:
            vae = self.pipe.vae
            X = to_tensor(image).to(self.device, self.dtype)
            region = torch.ones_like(X[:, :1])
            if keep_mask is not None:
                arr = np.asarray(keep_mask.convert("L").resize((SIZE, SIZE)), dtype=np.float32)
                region = torch.from_numpy((arr >= 127.5).astype(np.float32))[None, None]
                region = region.to(self.device, self.dtype)

            gray = torch.zeros_like(X)  # mid-gray is 0 in [-1, 1]
            with torch.no_grad():
                target = vae.encode(gray).latent_dist.mean

            # Attack what an inpainting pipeline encodes: the image with its
            # editable area blanked out (see prepare_mask_and_masked_image).
            base = X * region
            adv = (base + (torch.rand_like(X) * 2 - 1) * cfg.eps * region).clamp(-1, 1)
            losses: list[float] = []
            for i in range(cfg.iters):
                if should_stop():
                    raise Cancelled()
                step = cfg.step - (cfg.step - cfg.step / 100) / cfg.iters * i
                adv.requires_grad_(True)
                loss = (vae.encode(adv).latent_dist.mean - target).norm()
                grad, = torch.autograd.grad(loss, [adv])
                with torch.no_grad():
                    adv = adv - grad.sign() * step * region
                    adv = torch.minimum(torch.maximum(adv, base - cfg.eps), base + cfg.eps)
                    adv = adv.clamp(-1, 1).detach()
                value = loss.item()
                if not np.isfinite(value):
                    raise RuntimeError("Attack diverged (non-finite loss).")
                losses.append(value)
                event = {"iter": i + 1, "total": cfg.iters, "loss": value}
                if (i + 1) % preview_every == 0 or i == 0:
                    event["noise"] = noise_view(base, adv, cfg.eps)
                on_step(event)

            final = adv * region + X * (1 - region)
            protected = to_image(final)
            noise = noise_view(X, final, cfg.eps)
            self._flush()

        # Measured on the 8-bit file the user gets, not the float tensor.
        px = np.abs(np.asarray(protected, int) - np.asarray(image, int))
        return {
            "original": image,
            "protected": protected,
            "noise": noise,
            "stats": {
                "psnr": round(psnr(image, protected), 2),
                "max_change": int(px.max()),
                "mean_change": round(float(px.mean()), 2),
                "loss_start": round(losses[0], 2),
                "loss_end": round(losses[-1], 2),
                "iters": cfg.iters,
                "eps": cfg.eps,
                "device": self.device,
            },
        }

    def edit(
        self,
        image: Image.Image,
        edit_mask: Image.Image,
        prompt: str,
        seed: int,
        steps: int,
        guidance: float,
        on_step: Callable[[int, int], None],
        should_stop: Callable[[], bool],
    ) -> Image.Image:
        """Run the inpainting pipeline, as an attacker would. White = repaint."""
        with self.lock:
            pipe = self.pipe
            mask = edit_mask.convert("L").resize((SIZE, SIZE))

            def callback(_pipe, step, _t, kwargs):
                if should_stop():
                    raise Cancelled()
                on_step(step + 1, steps)
                return kwargs

            generator = torch.Generator("cpu").manual_seed(seed)
            result = pipe(
                prompt=prompt,
                image=image,
                mask_image=mask,
                height=SIZE,
                width=SIZE,
                eta=1,
                guidance_scale=guidance,
                num_inference_steps=steps,
                generator=generator,
                callback_on_step_end=callback,
            )
            out = result.images[0]
            flagged = result.nsfw_content_detected
            self._flush()
        if flagged and any(flagged):
            raise Blocked("The safety filter blocked this result.")
        # Keep unedited pixels exactly, as recover_image does in the original demo.
        return Image.composite(out, image, mask)
