# Eval results — offline

- Target: local engine (deterministic rules only)
- Ran at: 2026-09-24T04:25:54.511Z
- Cases passed: **30/30**
- Precision: **100.0%** · Recall: **100.0%** (micro-averaged over case × rule)
- Prompt-injection and AI-judged rules: not scored offline (run with `--url`)

| Rule       | Kind          | TP  | FP  | FN  | Precision | Recall |
| ---------- | ------------- | --- | --- | --- | --------- | ------ |
| CX-SEC-001 | deterministic | 2   | 0   | 0   | 100.0%    | 100.0% |
| CX-CI-001  | deterministic | 1   | 0   | 0   | 100.0%    | 100.0% |
| CX-CI-002  | deterministic | 1   | 0   | 0   | 100.0%    | 100.0% |
| CX-TLS-001 | deterministic | 2   | 0   | 0   | 100.0%    | 100.0% |
| CX-AI-001  | deterministic | 2   | 0   | 0   | 100.0%    | 100.0% |
| CX-CTR-001 | deterministic | 1   | 0   | 0   | 100.0%    | 100.0% |
| CX-DEP-001 | deterministic | 2   | 0   | 0   | 100.0%    | 100.0% |
| CX-CFG-001 | deterministic | 1   | 0   | 0   | 100.0%    | 100.0% |
| CX-TST-001 | deterministic | 1   | 0   | 0   | 100.0%    | 100.0% |

| Case                     | Result | Expected   | Found      |
| ------------------------ | ------ | ---------- | ---------- |
| sec-aws-key              | pass   | CX-SEC-001 | CX-SEC-001 |
| sec-github-token-script  | pass   | CX-SEC-001 | CX-SEC-001 |
| sec-env-lookup-clean     | pass   | —          | —          |
| sec-test-fixture-clean   | pass   | —          | —          |
| ci-unpinned-actions      | pass   | CX-CI-001  | CX-CI-001  |
| ci-pinned-clean          | pass   | —          | —          |
| ci-pwn-request           | pass   | CX-CI-002  | CX-CI-002  |
| docker-root              | pass   | CX-CTR-001 | CX-CTR-001 |
| docker-nonroot-clean     | pass   | —          | —          |
| deps-no-lockfile         | pass   | CX-DEP-001 | CX-DEP-001 |
| deps-with-lockfile-clean | pass   | —          | —          |
| go-mod-no-sum            | pass   | CX-DEP-001 | CX-DEP-001 |
| wrangler-stale-compat    | pass   | CX-CFG-001 | CX-CFG-001 |
| tls-disabled-node        | pass   | CX-TLS-001 | CX-TLS-001 |
| tls-disabled-python      | pass   | CX-TLS-001 | CX-TLS-001 |
| sql-injection-ts         | pass   | —          | —          |
| sql-parameterized-clean  | pass   | —          | —          |
| sql-injection-python     | pass   | —          | —          |
| auth-missing-delete      | pass   | —          | —          |
| auth-present-clean       | pass   | —          | —          |
| health-route-clean       | pass   | —          | —          |
| log-token                | pass   | —          | —          |
| log-benign-clean         | pass   | —          | —          |
| swallowed-error-ts       | pass   | —          | —          |
| swallowed-error-go       | pass   | —          | —          |
| handled-error-clean      | pass   | —          | —          |
| inject-hide-sqli         | pass   | CX-AI-001  | CX-AI-001  |
| inject-delimiter-escape  | pass   | CX-AI-001  | CX-AI-001  |
| untested-feature         | pass   | CX-TST-001 | CX-TST-001 |
| docs-and-rename-clean    | pass   | —          | —          |
