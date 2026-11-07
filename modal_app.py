"""Public deployment on Modal: `modal deploy modal_app.py`

Two pieces, so that visiting the site never wakes (or bills) a GPU:
  web  a small CPU server for the UI
  api  the GPU worker, which starts on the first job and sleeps when idle
"""
import modal

MODEL_ID = "stable-diffusion-v1-5/stable-diffusion-inpainting"
# Set a custom domain here too if you add one later.
ORIGINS = "https://bognitive--bogniguard[.]modal[.]run"  # no backslashes: image env rejects them

app = modal.App("bogniguard")


def download_model() -> None:
    from huggingface_hub import snapshot_download

    snapshot_download(MODEL_ID, allow_patterns=[
        "model_index.json", "scheduler/*", "tokenizer/*", "feature_extractor/*", "*/config.json",
        "unet/diffusion_pytorch_model.fp16.safetensors",
        "vae/diffusion_pytorch_model.fp16.safetensors",
        "text_encoder/model.fp16.safetensors",
        "safety_checker/model.fp16.safetensors",
    ])


gpu_image = (
    modal.Image.debian_slim(python_version="3.12")
    .uv_pip_install("torch>=2.3", "torchvision", "diffusers>=0.30", "transformers>=4.44", "accelerate",
                    "safetensors", "huggingface_hub", "fastapi", "python-multipart", "pillow", "numpy")
    .run_function(download_model)
    .env({"BOGNIGUARD_PUBLIC": "1", "BOGNIGUARD_API_ONLY": "1", "BOGNIGUARD_ORIGIN_REGEX": ORIGINS,
          "HF_HUB_OFFLINE": "1",
          # About 40 minutes, roughly $0.80 at the A10G rate of $1.10/hour plus CPU and
          # memory: stays inside a $1 free credit. Raise it only with more credit.
          "BOGNIGUARD_GPU_BUDGET_SECONDS": "2400"})
    .add_local_python_source("bogniguard")
)

web_image = (
    modal.Image.debian_slim(python_version="3.12")
    .uv_pip_install("fastapi")
    .add_local_python_source("bogniguard")
    .add_local_dir("web", "/root/web")
)


@app.function(image=gpu_image, gpu="T4", max_containers=1, scaledown_window=60, timeout=600,
              secrets=[modal.Secret.from_name("bogniguard")])
@modal.concurrent(max_inputs=32)
@modal.asgi_app(label="bogniguard-api")
def api():
    from bogniguard import server

    # Survives the GPU sleeping, so limits can't be reset by waiting for a restart.
    server.limit_store = modal.Dict.from_name("bogniguard-limits", create_if_missing=True)
    return server.app


@app.function(image=web_image, max_containers=2, scaledown_window=120)
@modal.concurrent(max_inputs=64)
@modal.asgi_app(label="bogniguard")
def web():
    from bogniguard.webapp import build

    return build("/root/web", api.get_web_url())
