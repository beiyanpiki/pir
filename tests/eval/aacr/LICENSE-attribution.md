# Attribution — AACR-Bench data and open-code-review prompt

This directory consumes two Apache-2.0 artifacts and vendors a port of a third-party prompt. Neither the dataset body nor any upstream source tree is committed here: `meta.json` pins the upstream revision and the sha256 of the downloaded file, and `fetch-dataset.js` re-downloads and verifies it on demand.

## AACR-Bench (data + framework)

- Dataset: `Alibaba-Aone/aacr-bench` on Hugging Face, file `dataset.json`, revision `47be1d6df1e7faf222cf531587772d92f79fe6b2`, sha256 `0804505f0a474765ce2840c832cfeaa6c4f0250dd6ccb169fe73c6758b245a86`.
- Framework: <https://github.com/alibaba/aacr-bench> (end-to-end benchmark judges with its pinned `judge.py`/`evaluate.py`).
- License: Apache-2.0. Use requires citing the paper:

```bibtex
@misc{zhang2026aacrbenchevaluatingautomaticcode,
  title={AACR-Bench: Evaluating Automatic Code Review with Holistic Repository-Level Context},
  author={Lei Zhang and Yongda Yu and Minghui Yu and others},
  year={2026}, eprint={2601.19494}, archivePrefix={arXiv}, primaryClass={cs.SE}
}
```

Every generated JSONL carries this notice in its header row and every results file under `results/` carries it in its header.

## open-code-review reflection prompt (OCR arm)

- Source: <https://github.com/alibaba/open-code-review>, revision `8eb8334`, files `internal/config/template/prompts/review_filter_task_system.md` and `review_filter_task_user.md` (comment reflection, `internal/agent/agent.go:1798`).
- License: Apache-2.0.
- Port: `src/agents/ocr-reflection-prompt.ts` reproduces the upstream prompt text for the verifier benchmark comparison arm, with the upstream paths, revision and license recorded in the module header. It is evaluation apparatus, not product prompt text: no product command imports it except the `_verify-comment` eval arm.
