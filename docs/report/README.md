# Project report (IEEE format)

`taskflow-ieee.tex` is the report (IEEEtran conference class); `taskflow-ieee.pdf` is the compiled copy.

```bash
python3 figures/make_figures.py      # needs matplotlib; writes figures/admission.pdf and drain.pdf
tectonic taskflow-ieee.tex           # or upload this folder to Overleaf
```

Every number in the Evaluation section is copied from [`docs/benchmarking/RESULTS.md`](../benchmarking/RESULTS.md); the figure script holds the same values.
