"""Test Creao's API Trigger (plan B transport) with your capi_ account key.

Usage (PowerShell):
    $env:CREAO_API_KEY = "capi_..."      # agent.creao.ai -> Settings -> API Keys
    python scripts/test_api_trigger.py <support_app_id> [input_field]

input_field defaults to "message" (the id of the agent's Input Form text field).
Costs two agent runs (one start + one continuation).
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = "https://agent.creao.ai"
KEY = os.environ.get("CREAO_API_KEY", "")
if not KEY.startswith("capi_"):
    sys.exit('Set CREAO_API_KEY first:  $env:CREAO_API_KEY = "capi_..."')
if len(sys.argv) not in (2, 3):
    sys.exit("Usage: python scripts/test_api_trigger.py <support_app_id> [input_field]")
APP_ID = sys.argv[1]
FIELD = sys.argv[2] if len(sys.argv) == 3 else "message"
RUN = str(int(time.time()))

ASSIGN = """[Dispatcher] @Support New task t_test: transport test.

```cofounder
{"type":"ASSIGN","task":"t_test","to":"support",
 "company":{"name":"Lumen Notes","product":"AI meeting notes","plans":[{"name":"Pro","price_cents":3500,"period":"month"}]},
 "brief":"Transport test. Do not call any tools. Reply with one sentence, then a REPORT envelope with no proposed_actions and one finding {claim: 'transport ok', evidence: 'test'}.",
 "token":"test","rules_in_scope":[],"data_hints":[],"refs":[],
 "reply":"End your reply with exactly one cofounder envelope. Never address other agents directly."}
```"""


def call(method, path, body=None):
    req = urllib.request.Request(
        BASE + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": f"Bearer {KEY}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "cofounder-test/1.0",  # Cloudflare blocks Python's default UA
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        text = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(text)
        except ValueError:
            return e.code, text


def show(step, status, data, limit=4000):
    print(f"\n=== {step}: HTTP {status} ===")
    print(json.dumps(data, indent=2)[:limit] if not isinstance(data, str) else data[:limit])


def start_and_wait(label, message, thread_id=None, attempt="a"):
    body = {"appId": APP_ID, "inputs": {FIELD: message}, "idempotencyKey": f"transport-test-{RUN}-{attempt}"}
    if thread_id:
        body["threadId"] = thread_id
    status, data = call("POST", "/api/v1/runs", body)
    show(f"{label}: POST /api/v1/runs", status, data)
    if status not in (200, 201, 202):
        sys.exit(f"\n{label} failed to start. Common causes: wrong App ID, wrong input field id "
                 f"(you sent '{FIELD}'), or credits.")
    run_id = data.get("id") or data.get("runId")
    for i in range(30):  # up to 5 min
        time.sleep(10)
        status, run = call("GET", f"/api/v1/runs/{run_id}")
        state = run.get("status") if isinstance(run, dict) else None
        print(f"  {10 * (i + 1)} s: {state}")
        if state in ("completed", "failed", "cancelled"):
            show(f"{label}: final run", status, run, limit=8000)
            return run
    sys.exit("Run did not finish in 5 min; check the [API] conversation in the Creao sidebar.")


run1 = start_and_wait("Run 1", ASSIGN)
if run1.get("status") != "completed":
    sys.exit(f"\nRun 1 ended as {run1.get('status')} (errorCode: {run1.get('errorCode')}).")
result = run1.get("result") or {}
for field in ("text", "chatText"):
    val = result.get(field) or ""
    print(f"\nresult.{field}: {len(val)} chars, cofounder block present: {'```cofounder' in val}")
thread_id = run1.get("threadId")
print("threadId:", thread_id)

if thread_id:
    run2 = start_and_wait(
        "Run 2 (continuation)",
        "[Dispatcher] @Support Follow-up on t_test: what task id did I just give you? "
        "Answer in one sentence, then the same REPORT envelope.",
        thread_id=thread_id, attempt="b",
    )
    text2 = json.dumps(run2.get("result") or {})
    print("\nContinuation remembers t_test:", "t_test" in text2)

print("\nDone. Send these outputs back. The two runs appear in the Creao sidebar as [API] ...")
