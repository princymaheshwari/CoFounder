#!/usr/bin/env python3
"""co: read Cofounder company data for the current task.

Python 3 standard library only. Calls the Cofounder backend (env COFOUNDER_URL, the Convex
site URL) with the task token from the ASSIGN. Prints compact JSON on stdout; on any error
prints {"error": "..."} and exits 1.

  co --token <TOKEN> data <view> [--id ID] [--limit N] [--since ISO_DATE]
  co --token <TOKEN> history <action_type> [--limit N]
  co --token <TOKEN> radar <url>
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

TIMEOUT_S = 20
USER_AGENT = "cofounder-co/1.0"
PLACEHOLDER = "[task-token]"


def emit(obj):
    print(json.dumps(obj, separators=(",", ":")))


def fail(message):
    emit({"error": message})
    sys.exit(1)


class Parser(argparse.ArgumentParser):
    def error(self, message):  # argparse exits 2 with text; co always answers in JSON
        fail(f"{message}. {self.format_usage().strip()}")


def call(base, token, method, path, query=None, body=None):
    url = base.rstrip("/") + path
    if query:
        url += "?" + urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json", "User-Agent": USER_AGENT}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as res:
            status, raw = res.status, res.read()
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read()
    except (urllib.error.URLError, OSError) as e:
        fail(f"cannot reach Cofounder at {base}: {getattr(e, 'reason', e)}")
    try:
        payload = json.loads(raw.decode("utf-8")) if raw else None
    except ValueError:
        payload = None
    if 200 <= status < 300 and payload is not None:
        return payload
    message = payload.get("error") if isinstance(payload, dict) else None
    fail(f"{message or 'unexpected response'} (HTTP {status})")


def main(argv=None):
    # --token/--url are accepted before or after the subcommand.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--token", default=argparse.SUPPRESS, help="task token from your ASSIGN")
    common.add_argument("--url", default=argparse.SUPPRESS, help="Cofounder site URL (default: $COFOUNDER_URL)")

    parser = Parser(prog="co", description="Read Cofounder company data for the current task.", parents=[common])
    sub = parser.add_subparsers(dest="command", parser_class=Parser)

    data = sub.add_parser("data", parents=[common], help="read a data view")
    data.add_argument("view", help="ticket, tickets, customer, ledger, duplicates, signals, budget, usage, thread, rules, company")
    data.add_argument("--id", help="record id (ticket, customer, thread)")
    data.add_argument("--limit", type=int, help="max rows")
    data.add_argument("--since", help="ledger only: ISO date, e.g. 2026-10-20")

    history = sub.add_parser("history", parents=[common], help="founder decisions for an action type")
    history.add_argument("action_type")
    history.add_argument("--limit", type=int)

    radar = sub.add_parser("radar", parents=[common], help="on-demand scan of a URL")
    radar.add_argument("target", metavar="url")

    args = parser.parse_args(argv)
    if not args.command:
        fail(f"missing command. {parser.format_usage().strip()}")

    token = getattr(args, "token", None) or os.environ.get("CO_TOKEN")
    if not token:
        fail("missing --token: pass the token from your ASSIGN's cofounder block")
    if token == PLACEHOLDER:
        fail("--token is the placeholder; pass the real token from your ASSIGN's cofounder block")
    base = getattr(args, "url", None) or os.environ.get("COFOUNDER_URL")
    if not base:
        fail("COFOUNDER_URL is not set (Creao secret with the Convex site URL)")

    if args.command == "data":
        result = call(base, token, "GET", "/co/data", {"view": args.view, "id": args.id, "limit": args.limit, "since": args.since})
    elif args.command == "history":
        result = call(base, token, "GET", "/co/history", {"action_type": args.action_type, "limit": args.limit})
    else:
        result = call(base, token, "POST", "/co/radar", body={"url": args.target})
    emit(result)


if __name__ == "__main__":
    main()
