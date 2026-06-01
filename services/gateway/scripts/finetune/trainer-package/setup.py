from setuptools import find_packages, setup

# v0.1.1 (VTID-03244): drop `torch` from install_requires.
#
# CustomJob 3154255301083922432 (2026-06-01) failed in transformers'
# `requires_backends(AutoModelForCausalLM)` with
# "ImportError: AutoModelForCausalLM requires the PyTorch library
#  but it was not found in your environment."
#
# Root cause: the Vertex Custom Training base image
# `us-docker.pkg.dev/vertex-ai/training/pytorch-gpu.2-3.py310` already
# ships PyTorch 2.3 in /opt/python/3.10/site-packages. Listing
# `torch>=2.3.0` in install_requires made pip (re)install torch into
# /root/.local/lib/python3.10/site-packages on top of the trainer
# package install — a partial/broken install that shadowed the
# pre-installed runtime PyTorch, breaking transformers' backend
# detection.
#
# Fix: trust the container's pre-installed torch. The trainer's other
# install_requires (transformers / accelerate / peft / datasets /
# sentencepiece) all support torch 2.3 and will resolve cleanly
# against the container's torch.

setup(
    name="finetune-trainer",
    version="0.1.1",
    packages=find_packages(),
    install_requires=[
        "accelerate>=0.34.0",
        "datasets>=2.20.0",
        "google-cloud-storage>=2.16.0",
        "peft>=0.12.0",
        "sentencepiece>=0.2.0",
        # torch intentionally NOT listed — provided by the
        # pytorch-gpu.2-3.py310 base container.
        "transformers>=4.44.0",
    ],
)
