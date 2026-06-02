import argparse
import json
import os
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from google.cloud import storage


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", required=True)
    parser.add_argument("--base-model", required=True)
    parser.add_argument("--dataset-prefix", required=True)
    parser.add_argument("--field-input", default="payload.user_input")
    parser.add_argument("--field-output", default="payload.tool_chosen")
    parser.add_argument("--min-rows-required", type=int, default=1000)
    parser.add_argument("--output-uri", required=True)
    parser.add_argument("--epochs", type=float, default=3)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--learning-rate", type=float, default=2e-4)
    parser.add_argument("--warmup-steps", type=int, default=50)
    parser.add_argument("--gradient-accumulation-steps", type=int, default=2)
    parser.add_argument("--max-seq-len", type=int, default=512)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    print(f"[trainer] target={args.target} base_model={args.base_model}")
    rows = load_jsonl_rows(args.dataset_prefix)
    rows = [
        row for row in rows
        if get_path(row, args.field_input) and get_path(row, args.field_output)
    ]
    print(f"[trainer] usable_rows={len(rows)} min_rows_required={args.min_rows_required}")
    if len(rows) < args.min_rows_required:
        raise RuntimeError(
            f"dataset has {len(rows)} usable rows; {args.min_rows_required} required"
        )

    train_texts = [
        format_training_text(
            str(get_path(row, args.field_input)),
            str(get_path(row, args.field_output)),
        )
        for row in rows
    ]

    # Import heavy ML dependencies only after dataset validation, so data/setup
    # errors fail fast without spending GPU time.
    import torch
    from datasets import Dataset
    from peft import LoraConfig, TaskType, get_peft_model
    from transformers import (
        AutoModelForCausalLM,
        AutoTokenizer,
        DataCollatorForLanguageModeling,
        Trainer,
        TrainingArguments,
    )

    # Env banner (v0.1.2): print resolved torch/numpy/transformers versions as
    # the first lines after import so env drift (e.g. NumPy 2.x shadowing the
    # container's torch 2.3) is visible immediately instead of as an opaque
    # "PyTorch not found" failure later. See setup.py failure history.
    import numpy as _np
    import transformers as _tf
    print(
        f"[env] torch={torch.__version__} numpy={_np.__version__} "
        f"transformers={_tf.__version__} cuda_available={torch.cuda.is_available()}",
        flush=True,
    )

    hf_token = os.environ.get("HF_TOKEN") or None
    tokenizer = AutoTokenizer.from_pretrained(args.base_model, token=hf_token, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
    model = AutoModelForCausalLM.from_pretrained(
        args.base_model,
        token=hf_token,
        trust_remote_code=True,
        torch_dtype=dtype,
    )
    model.config.use_cache = False

    lora = LoraConfig(
        r=16,
        lora_alpha=32,
        lora_dropout=0.05,
        task_type=TaskType.CAUSAL_LM,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
    )
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()

    dataset = Dataset.from_dict({"text": train_texts})

    def tokenize(batch: dict[str, list[str]]) -> dict[str, Any]:
        return tokenizer(
            batch["text"],
            truncation=True,
            max_length=args.max_seq_len,
            padding=False,
        )

    tokenized = dataset.map(tokenize, batched=True, remove_columns=["text"])
    output_dir = tempfile.mkdtemp(prefix="vitana-finetune-")
    training_args = TrainingArguments(
        output_dir=output_dir,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.gradient_accumulation_steps,
        learning_rate=args.learning_rate,
        warmup_steps=args.warmup_steps,
        logging_steps=10,
        save_strategy="epoch",
        report_to=[],
        bf16=torch.cuda.is_available(),
    )
    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=tokenized,
        data_collator=DataCollatorForLanguageModeling(tokenizer=tokenizer, mlm=False),
    )
    trainer.train()

    final_dir = Path(output_dir) / "final"
    # safe_serialization=False (v0.1.3): Qwen2.5 ties the input embeddings to the
    # LM head, so safetensors' shared-tensor scan (_find_shared_tensors) hits
    # "Attempted to access the data pointer on an invalid python storage" and the
    # save aborts AFTER training completes (CustomJob 3932080612898242560,
    # 2026-06-02). Writing the PEFT adapter as a pickle .bin sidesteps the tied-
    # tensor check; fine for a LoRA adapter artifact.
    model.save_pretrained(final_dir, safe_serialization=False)
    tokenizer.save_pretrained(final_dir)
    write_manifest(final_dir, args, len(rows))
    upload_directory(final_dir, args.output_uri)
    print(f"[trainer] uploaded artifacts to {args.output_uri}")


def load_jsonl_rows(gcs_prefix: str) -> list[dict[str, Any]]:
    client = storage.Client()
    bucket_name, prefix = split_gcs_uri(gcs_prefix)
    bucket = client.bucket(bucket_name)
    rows: list[dict[str, Any]] = []
    for blob in client.list_blobs(bucket, prefix=prefix):
        if not blob.name.endswith(".jsonl"):
            continue
        print(f"[trainer] reading gs://{bucket_name}/{blob.name}")
        raw = blob.download_as_text()
        for line in raw.splitlines():
            if line.strip():
                rows.append(json.loads(line))
    return rows


def upload_directory(local_dir: Path, output_uri: str) -> None:
    client = storage.Client()
    bucket_name, prefix = split_gcs_uri(output_uri)
    bucket = client.bucket(bucket_name)
    for path in local_dir.rglob("*"):
        if path.is_file():
            rel = path.relative_to(local_dir).as_posix()
            blob = bucket.blob(f"{prefix.rstrip('/')}/{rel}")
            blob.upload_from_filename(path)
            print(f"[trainer] uploaded gs://{bucket_name}/{blob.name}")


def write_manifest(local_dir: Path, args: argparse.Namespace, row_count: int) -> None:
    manifest = {
        "target": args.target,
        "base_model": args.base_model,
        "dataset_prefix": args.dataset_prefix,
        "row_count": row_count,
        "output_uri": args.output_uri,
    }
    (local_dir / "vitana_training_manifest.json").write_text(json.dumps(manifest, indent=2))


def split_gcs_uri(uri: str) -> tuple[str, str]:
    parsed = urlparse(uri)
    if parsed.scheme != "gs" or not parsed.netloc:
        raise ValueError(f"not a gs:// URI: {uri}")
    return parsed.netloc, parsed.path.lstrip("/")


def get_path(row: dict[str, Any], dotted: str) -> Any:
    current: Any = row
    for part in dotted.split("."):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def format_training_text(user_input: str, tool_name: str) -> str:
    return (
        "Route this Vitana voice request to the single best tool.\n"
        f"User request: {user_input}\n"
        f"Tool: {tool_name}"
    )


if __name__ == "__main__":
    main()
