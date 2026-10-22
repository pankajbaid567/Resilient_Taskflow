"""Generate the evaluation figures for the report.

Every number below is copied from docs/benchmarking/RESULTS.md (scenario 1 and
scenario 2). Nothing is computed or extrapolated here. Run:

    python3 make_figures.py        # writes admission.pdf and drain.pdf here
"""

import os

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
plt.rcParams.update({"font.size": 8, "font.family": "serif", "axes.linewidth": 0.6})

# Scenario 1: POST /api/v1/jobs, constant arrival rate, 60 s per rate.
rates = [100, 250, 500, 750, 1000, 1500]
p50 = [7.5, 3.8, 3.7, 243.2, 1403.1, 1398.3]
p95 = [19.6, 27.4, 200.3, 1157.7, 1900.2, 3079.9]
p99 = [74.5, 135.0, 345.7, 1554.1, 2417.1, 3943.1]

fig, ax = plt.subplots(figsize=(3.4, 2.3))
ax.plot(rates, p50, "o-", label="p50", linewidth=1, markersize=3)
ax.plot(rates, p95, "s-", label="p95", linewidth=1, markersize=3)
ax.plot(rates, p99, "^-", label="p99", linewidth=1, markersize=3)
ax.axhline(1000, color="gray", linestyle=":", linewidth=0.8)
ax.text(100, 1100, "1 s", ha="left", va="bottom", color="gray")
ax.set_xlabel("Target arrival rate (requests/s)")
ax.set_ylabel("Latency (ms, log scale)")
ax.set_yscale("log")
ax.set_xticks(rates)
ax.set_xticklabels([str(r) for r in rates], rotation=45)
ax.legend(frameon=False, loc="upper left")
ax.grid(True, which="both", linewidth=0.3, alpha=0.5)
fig.tight_layout()
fig.savefig(os.path.join(HERE, "admission.pdf"))
plt.close(fig)

# Scenario 2: 20,000 noop jobs drained by N workers, three runs each.
runs = {1: [217, 235, 211], 2: [249, 227, 247], 4: [206, 195, 207]}
workers = sorted(runs)
means = [sum(runs[w]) / len(runs[w]) for w in workers]

fig, ax = plt.subplots(figsize=(3.4, 2.1))
ax.bar([str(w) for w in workers], means, width=0.5, color="#9bb7d4", edgecolor="black", linewidth=0.5)
for i, w in enumerate(workers):
    ax.scatter([i] * len(runs[w]), runs[w], color="black", s=8, zorder=3)
ax.set_xlabel("Worker processes")
ax.set_ylabel("Drain throughput (jobs/s)")
ax.set_ylim(0, 300)
ax.grid(True, axis="y", linewidth=0.3, alpha=0.5)
fig.tight_layout()
fig.savefig(os.path.join(HERE, "drain.pdf"))
plt.close(fig)

print("wrote admission.pdf and drain.pdf")
