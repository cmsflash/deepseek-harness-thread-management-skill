#!/usr/bin/env python3
"""Read another DSH thread's last round: the human prompt and the final reply.

Fetches a bounded tail of the target session's log through the host's local
RPC API (session.history) and prints the last completed assistant reply and
the last human prompt, flagging a final turn that ended without a reply
(running, interrupted, or dead in LLM retries).
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import urllib.request


def discover_base_url() -> str:
    try:
        out = subprocess.run(
            ['bash', '-c', 'lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep "node.*bin.js --profile web"'],
            capture_output=True, text=True,
        ).stdout
        port = re.search(r':(\d+)\s+\(LISTEN\)', out)
        if port:
            return f'http://127.0.0.1:{port.group(1)}'
    except OSError:
        pass
    return 'http://127.0.0.1:3080'


def rpc(base_url: str, method: str, payload: dict) -> dict:
    body = json.dumps({
        'type': 'client-request',
        'rpcId': f'cli-{method}',
        'method': method,
        'payload': payload,
    }).encode()
    request = urllib.request.Request(
        f'{base_url}/api/{method}', data=body,
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def value_of(result: dict, method: str) -> dict:
    res = result.get('result', {})
    if not res.get('ok'):
        error = res.get('error', {})
        print(f"error: {method}: {error.get('code', '?')}: {error.get('message', '')}", file=sys.stderr)
        raise SystemExit(1)
    return res.get('value', {})


def block_text(blocks: object) -> str:
    if not isinstance(blocks, list):
        return ''
    return '\n'.join(
        block.get('text', '')
        for block in blocks
        if isinstance(block, dict) and block.get('type') == 'text'
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--session', required=True, help='target sessionId')
    parser.add_argument('--base-url', default=None, help='host base URL (default: discovered, else http://127.0.0.1:3080)')
    parser.add_argument('--max-messages', type=int, default=8, help='tail page size in whole messages (default 8)')
    args = parser.parse_args()

    base = args.base_url or discover_base_url()

    listing = value_of(rpc(base, 'session.list', {}), 'session.list')
    summary = next((item for item in listing.get('items', []) if item.get('sessionId') == args.session), None)
    if summary is None:
        print(f"error: session {args.session} not found in session.list", file=sys.stderr)
        return 1
    title = ((summary.get('projections') or {}).get('values') or {}).get('title') or '(untitled)'
    print(f"session : {args.session}")
    print(f"title   : {title}   running: {summary.get('running')}")

    history = value_of(rpc(base, 'session.history', {
        'sessionId': args.session,
        'maxMessages': args.max_messages,
    }), 'session.history')
    entries = history.get('events', [])
    events = [entry.get('event', entry) for entry in entries]
    print(f"page    : {len(events)} events (hasMore: {history.get('hasMore')})")
    print()

    last_prompt = None  # (seq, text) of the last human-authored message
    last_reply = None   # (seq, text) of the last assistant message carrying text
    for event in events:
        etype = event.get('type')
        data = event.get('data', {})
        if etype == 'user/message':
            if data.get('source', {}).get('kind') != 'user':
                continue  # context injections (instructions/catalog/plugin) are not human prompts
            text = block_text(data.get('content'))
            if text:
                last_prompt = (event.get('seq'), text)
        elif etype == 'assistant/message':
            text = block_text((data.get('message') or {}).get('content'))
            if text:
                last_reply = (event.get('seq'), text)

    if last_prompt is None and last_reply is None:
        print('no human prompts or assistant replies in the tail page; try a larger --max-messages')
        return 1

    if last_prompt is not None:
        seq, text = last_prompt
        print(f'last human prompt (seq {seq}):')
        print(text)
        print()

    if last_reply is None:
        print('no assistant reply with text in the tail page; try a larger --max-messages')
        return 1

    seq, text = last_reply
    if last_prompt is not None and last_prompt[0] > seq:
        print('NOTE: the final turn has no reply yet (running, interrupted, or LLM retries).')
        print('Last COMPLETED reply:')
    print(f'last final reply (seq {seq}, {len(text)} chars):')
    print(text)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
