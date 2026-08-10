# Language-server performance

Run the real generated-workspace benchmark with:

```sh
npm run benchmark:lsp -- --sizes=1000,5000,10000
```

CI runs the 1,000-file scenario with `--assert`. Budgets grow linearly with the
requested workspace size for indexing, references, and heap usage, while warmed
interactive operations have fixed ceilings. A breached budget fails the job and
prints the metric, measured value, and limit.

It creates actual files and imports, performs cold/warm indexing, definition, references, completion, one-document incremental update, shared-dependent update, and records process heap usage.

Measurements on 2026-07-17 (Apple Silicon, Node.js 22.22.3):

|  Files | Cold index | Warm index | Definition | References | Completion | One file | Shared dependency |      Heap |
| -----: | ---------: | ---------: | ---------: | ---------: | ---------: | -------: | ----------------: | --------: |
|  1,000 |     297 ms |      28 ms |    0.36 ms |    3.30 ms |    0.34 ms |  0.62 ms |           0.36 ms |  58.6 MiB |
|  5,000 |     807 ms |     124 ms |    0.10 ms |   15.16 ms |    0.09 ms |  0.31 ms |           2.00 ms | 110.8 MiB |
| 10,000 |   1,602 ms |     248 ms |    0.11 ms |   24.86 ms |    0.07 ms |  0.33 ms |           1.83 ms | 147.5 MiB |

The 10k definition and completion measurements are below the 50 ms and 100 ms warmed targets. A first benchmark exposed quadratic reverse-dependency invalidation (8.37 seconds at 10k); per-document cache-key buckets reduced the same measured operation to 1.83 ms.
