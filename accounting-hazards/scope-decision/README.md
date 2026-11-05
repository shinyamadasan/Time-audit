# TASK-039 local scope-decision diagnostics

Base: d50a44f1b2d4b14de99efac76f3ac3793cb0c4a5. Synthetic accounts only.
The generator makes local test copies from the unchanged checkpoint test source; it edits no runtime.
Run the generator before either browser command in RESULTS.json. Use the installed Playwright CLI;
the test harness requires Java, the cached RTDB emulator, Chromium and existing node_modules.

The original-style instrumented run intentionally retains the original failing assertion. It is
expected to expose the race intermittently; repetitions do not prove safety. The controlled tests
force the existing heartbeat trigger before abort-route removal, verify retained UNKNOWN across
reload, then deliver only the captured original command from the test harness. A pass proves the
defect/retention mechanism, not a repaired adapter.

observed-failure.json was extracted from the instrumented failure trace. Controlled evidence files
contain state snapshots after each page evaluation plus local REST request/response events; request
URLs omit query credentials. All values are synthetic. The raw snapshots include full frozen facts,
commands, local frames and receipts. Generated test copies and browser trace output are ignored.

The design and one recommended release strategy are in ../../TASK_039_ACCOUNTING_CONTRACT.md.
No production write, rule activation, application integration or Guardian run is part of this proof.
