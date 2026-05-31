from setuptools import find_packages, setup

setup(
    name="finetune-trainer",
    version="0.1.0",
    packages=find_packages(),
    install_requires=[
        "accelerate>=0.34.0",
        "datasets>=2.20.0",
        "google-cloud-storage>=2.16.0",
        "peft>=0.12.0",
        "sentencepiece>=0.2.0",
        "transformers>=4.44.0",
    ],
)
