from setuptools import find_packages, setup

# v0.1.2 (BOOTSTRAP-35DAY-TRACKER): bound every dependency so `pip install
# --user` cannot drag NumPy 2.x (or a too-new transformers) onto the worker.
#
# Failure history:
#   * CustomJob 3154255301083922432 (2026-06-01): "AutoModelForCausalLM
#     requires the PyTorch library but it was not found." v0.1.0 listed
#     torch>=2.3.0 → pip reinstalled a partial torch into /root/.local that
#     shadowed the container torch. v0.1.1 dropped torch — but the error
#     RECURRED on CustomJob 3852431990582149120 (2026-06-02).
#   * Real root cause (v0.1.2): the OTHER deps were UNBOUNDED. On the worker,
#     `transformers>=4.44.0` / `datasets>=2.20.0` resolve to their latest
#     2026 releases, which pull **NumPy 2.x** into /root/.local. The base
#     image `pytorch-gpu.2-3.py310` ships **PyTorch 2.3, which is NOT
#     compatible with NumPy 2.x** → `import torch` fails at runtime →
#     transformers reports "PyTorch not found."
#
# Fix: keep trusting the container's torch (do NOT list it) but PIN numpy<2
# and cap transformers/peft/accelerate/datasets to torch-2.3-era ranges that
# are known to support both PyTorch 2.3 and Qwen2.5. train.py also prints a
# torch/numpy/transformers version banner at startup so any residual env
# drift is visible in the first log lines instead of as an opaque ImportError.

setup(
    name="finetune-trainer",
    version="0.1.2",
    packages=find_packages(),
    install_requires=[
        # CRITICAL: torch 2.3 (container) is incompatible with numpy>=2.
        "numpy<2.0",
        "accelerate>=0.34.0,<1.1.0",
        "datasets>=2.20.0,<3.0.0",
        "google-cloud-storage>=2.16.0",
        "peft>=0.12.0,<0.14.0",
        "sentencepiece>=0.2.0",
        # torch intentionally NOT listed — provided by the
        # pytorch-gpu.2-3.py310 base container. Bounded transformers so it
        # stays compatible with the container's torch 2.3.
        "transformers>=4.44.0,<4.46.0",
    ],
)
