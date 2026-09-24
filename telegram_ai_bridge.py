#!/usr/bin/env python3
"""
TK Empire Telegram AI Bridge
Private, read-only Telegram assistant for Genesis / EIP.

Security boundaries:
- Only TELEGRAM_ALLOWED_CHAT_ID (or TELEGRAM_PRIVATE_ID fallback) may use the bot.
- No trading/exchange write actions are implemented.
- No Telegram or OpenAI secrets are stored in this file.
- Secrets are read from /root/tkempire/.env.
"""

import json
import os
import time
from collections import defaultdict, deque
from pathlib import Path

import requests
from dotenv import load_dotenv

ENV_PATH = os.getenv("TK_EMPIRE_ENV", "/root/tkempire/.env")
load_dotenv(ENV_PATH)

TG_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
ALLOWED_CHAT_ID = (
    os.getenv("TELEGRAM_ALLOWED_CHAT_ID")
    or os.getenv("TELEGRAM_PRIVATE_ID")
    or ""
).strip()
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-5.6-sol").strip()

TG_API = f"https://api.telegram.org/bot{TG_TOKEN}"
LOCAL_API = os.getenv("TK_EMPIRE_LOCAL_API", "http://127.0.0.1:5000").rstrip("/")
LATEST_MILESTONE = Path(
    os.getenv(
        "TK_EMPIRE_LATEST_MILESTONE",
        "/root/tkempire/data/genesis/milestones/LATEST.json",
    )
)

POLL_TIMEOUT = 45
HTTP_TIMEOUT = 15
MAX_HISTORY_ITEMS = 12
MAX_CONTEXT_CHARS = 24000
MAX_REPLY_CHARS = 3900

history = defaultdict(lambda: deque(maxlen=MAX_HISTORY_ITEMS))

SYSTEM_PROMPT = """You are Nyra, the private TK Empire / Genesis intelligence assistant in Telegram.

Operating rules:
- Be direct, concise, useful, and grounded in the supplied Empire context.
- Treat Genesis market information as research/validation unless the supplied state explicitly says otherwise.
- Never claim a live trade exists unless the canonical current state says so.
- Never invent prices, positions, returns, milestones, service health, or execution authority.
- You have READ-ONLY informational authority in this Telegram bridge.
- You cannot place, modify, or cancel exchange orders.
- You cannot widen trading authority, modify risk, restart services, or change Genesis configuration.
- If the user asks for an execution-changing action, explain that the Telegram bridge is read-only and identify the safe next operational step.
- Distinguish current live state from historical records.
- When discussing a current active mission, use the canonical /health open_trades data.
- Keep responses suitable for Telegram.
"""


def require_config():
    missing = []
    if not TG_TOKEN:
        missing.append("TELEGRAM_BOT_TOKEN")
    if not ALLOWED_CHAT_ID:
        missing.append("TELEGRAM_ALLOWED_CHAT_ID or TELEGRAM_PRIVATE_ID")
    if missing:
        raise SystemExit("Missing required environment values: " + ", ".join(missing))


def tg_call(method, payload=None, timeout=HTTP_TIMEOUT):
    r = requests.post(
        f"{TG_API}/{method}",
        json=payload or {},
        timeout=timeout,
    )
    r.raise_for_status()
    data = r.json()
    if not data.get("ok"):
        raise RuntimeError(f"Telegram {method} failed: {data}")
    return data.get("result")


def send_text(chat_id, text):
    text = str(text or "").strip() or "No response."
    chunks = []
    while text:
        if len(text) <= MAX_REPLY_CHARS:
            chunks.append(text)
            break
        cut = text.rfind("\n", 0, MAX_REPLY_CHARS)
        if cut < 1000:
            cut = MAX_REPLY_CHARS
        chunks.append(text[:cut])
        text = text[cut:].lstrip()

    for chunk in chunks:
        tg_call(
            "sendMessage",
            {
                "chat_id": chat_id,
                "text": chunk,
                "disable_web_page_preview": True,
            },
        )


def get_json(url):
    try:
        r = requests.get(url, timeout=HTTP_TIMEOUT)
        r.raise_for_status()
        return r.json()
    except Exception as exc:
        return {"_error": str(exc)}


def load_milestone():
    try:
        return json.loads(LATEST_MILESTONE.read_text(encoding="utf-8"))
    except Exception as exc:
        return {"_error": str(exc)}


def canonical_snapshot():
    health = get_json(f"{LOCAL_API}/health")
    status = get_json(f"{LOCAL_API}/api/genesis/status")
    thoughts = get_json(f"{LOCAL_API}/api/genesis-thoughts")
    weights = get_json(f"{LOCAL_API}/api/genesis-weights")
    milestone = load_milestone()

    snapshot = {
        "health": health,
        "genesis_status": status,
        "recent_thoughts": (thoughts.get("thoughts") or [])[-12:]
        if isinstance(thoughts, dict)
        else [],
        "weights": (weights.get("weights") or [])[:20]
        if isinstance(weights, dict)
        else [],
        "latest_milestone": milestone,
    }
    raw = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))
    if len(raw) > MAX_CONTEXT_CHARS:
        raw = raw[:MAX_CONTEXT_CHARS] + "...[truncated]"
    return raw


def active_trades_from_health():
    health = get_json(f"{LOCAL_API}/health")
    open_trades = health.get("open_trades") if isinstance(health, dict) else {}
    trades = open_trades.get("trades") if isinstance(open_trades, dict) else []
    return health, trades if isinstance(trades, list) else []


def cmd_status():
    health = get_json(f"{LOCAL_API}/health")
    status = get_json(f"{LOCAL_API}/api/genesis/status")

    engine = health.get("engine", {}) if isinstance(health, dict) else {}
    checks = health.get("checks", {}) if isinstance(health, dict) else {}
    open_trades = health.get("open_trades", {}) if isinstance(health, dict) else {}
    perf = status.get("performance", {}) if isinstance(status, dict) else {}
    positions = status.get("positions", {}) if isinstance(status, dict) else {}

    return (
        "TK EMPIRE // GENESIS STATUS\n"
        f"Health: {str(health.get('status', 'unknown')).upper()} "
        f"({health.get('health_score', '—')}%)\n"
        f"Mode: {str(engine.get('mode', '—')).upper()}\n"
        f"Regime: {str(engine.get('regime', '—')).upper()}\n"
        f"Open missions: {open_trades.get('count', positions.get('open', 0))}\n"
        f"Trades tracked: {perf.get('trades', '—')}\n"
        f"Win rate: {perf.get('win_rate', '—')}%\n"
        f"Total PnL: {perf.get('total_pnl', '—')}\n"
        f"Engine check: {'ONLINE' if checks.get('engine') else 'OFFLINE'}\n"
        "Authority: READ-ONLY TELEGRAM BRIDGE"
    )


def cmd_signal():
    _, trades = active_trades_from_health()
    if not trades:
        return (
            "GENESIS CURRENT MISSION\n"
            "No active mission. Genesis is scanning for the next qualified setup."
        )

    blocks = []
    for t in trades[:5]:
        blocks.append(
            "\n".join(
                [
                    f"{str(t.get('coin', 'ASSET')).upper()} "
                    f"{str(t.get('action', '')).upper()}",
                    f"Entry: {t.get('entry', '—')}",
                    f"TP1: {t.get('tp1', '—')}",
                    f"TP2: {t.get('tp2', '—')}",
                    f"Stop: {t.get('stop', '—')}",
                    f"Score: {t.get('score', '—')}",
                    f"Reason: {t.get('reason', '—')}",
                ]
            )
        )
    return "GENESIS CURRENT MISSION\n\n" + "\n\n".join(blocks)


def cmd_research():
    thoughts = get_json(f"{LOCAL_API}/api/genesis-thoughts")
    rows = thoughts.get("thoughts", []) if isinstance(thoughts, dict) else []
    if not rows:
        return "GENESIS RESEARCH\nNo recent thought-stream entries are available."
    out = ["GENESIS RESEARCH // RECENT"]
    for t in rows[-8:][::-1]:
        out.append(
            f"{t.get('timestamp', '')} | {t.get('coin', '')} "
            f"{t.get('action', '')} | {t.get('message', '')}"
        )
    return "\n".join(out)


def cmd_milestone():
    m = load_milestone()
    if "_error" in m:
        return "MILESTONE\nUnable to read the latest milestone: " + m["_error"]
    return (
        "EMPIRE MILESTONE\n"
        f"Title: {m.get('title', m.get('milestone_title', '—'))}\n"
        f"Status: {m.get('status', '—')}\n"
        f"Current: {m.get('exact_current_milestone', '—')}\n"
        f"Next stage: {m.get('exact_next_stage', '—')}\n"
        f"Next action: {m.get('exact_next_action', '—')}"
    )


def extract_response_text(data):
    if not isinstance(data, dict):
        return ""
    if data.get("output_text"):
        return str(data["output_text"]).strip()

    parts = []
    for item in data.get("output", []) or []:
        if not isinstance(item, dict):
            continue
        for content in item.get("content", []) or []:
            if not isinstance(content, dict):
                continue
            if content.get("type") == "output_text" and content.get("text"):
                parts.append(str(content["text"]))
    return "\n".join(parts).strip()


def ask_openai(chat_id, user_text):
    if not OPENAI_API_KEY:
        return (
            "Natural-language AI is not active yet because OPENAI_API_KEY "
            "is not set on the VPS. /status, /signal, /research, and /milestone "
            "still work without it."
        )

    prior = list(history[str(chat_id)])
    transcript = "\n".join(
        f"{role.upper()}: {text}" for role, text in prior
    )

    context = canonical_snapshot()
    user_input = (
        "CURRENT EMPIRE CONTEXT (read-only, canonical where noted):\n"
        + context
        + "\n\nRECENT TELEGRAM CONVERSATION:\n"
        + (transcript or "(none)")
        + "\n\nUSER MESSAGE:\n"
        + user_text
    )

    r = requests.post(
        "https://api.openai.com/v1/responses",
        headers={
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "model": OPENAI_MODEL,
            "store": False,
            "instructions": SYSTEM_PROMPT,
            "input": user_input,
        },
        timeout=60,
    )
    r.raise_for_status()
    reply = extract_response_text(r.json())
    if not reply:
        reply = "The AI returned no text response."

    history[str(chat_id)].append(("user", user_text))
    history[str(chat_id)].append(("assistant", reply))
    return reply


HELP_TEXT = """TK EMPIRE TELEGRAM AI

/status - Genesis health, regime, performance
/signal - Canonical active mission
/research - Recent Genesis thought stream
/milestone - Latest Empire milestone
/reset - Clear this bot's short conversation context
/help - Show commands

Or send a normal message to talk with Nyra using live Empire context.

Security: this bridge is read-only. It cannot place or modify trades.
"""


def handle_message(message):
    chat = message.get("chat", {})
    chat_id = str(chat.get("id", ""))
    text = str(message.get("text") or "").strip()

    if chat_id != ALLOWED_CHAT_ID:
        if chat_id:
            send_text(chat_id, "This TK Empire bot is private.")
        return

    if not text:
        send_text(chat_id, "Text messages are supported in V1. Use /help.")
        return

    command = text.split()[0].lower()
    if command == "/help" or command == "/start":
        reply = HELP_TEXT
    elif command == "/status":
        reply = cmd_status()
    elif command == "/signal":
        reply = cmd_signal()
    elif command == "/research":
        reply = cmd_research()
    elif command == "/milestone":
        reply = cmd_milestone()
    elif command == "/reset":
        history[str(chat_id)].clear()
        reply = "Telegram conversation context cleared. Empire live context remains available."
    else:
        reply = ask_openai(chat_id, text)

    send_text(chat_id, reply)


def ensure_no_webhook():
    info = tg_call("getWebhookInfo")
    if info and info.get("url"):
        raise SystemExit(
            "A Telegram webhook is already configured for this bot. "
            "This V1 bridge uses getUpdates long polling. "
            "Remove or migrate the webhook deliberately before starting."
        )


def main():
    require_config()
    ensure_no_webhook()

    print("TK Empire Telegram AI Bridge starting")
    print(f"Allowed chat id configured: {'yes' if ALLOWED_CHAT_ID else 'no'}")
    print(f"OpenAI enabled: {'yes' if OPENAI_API_KEY else 'no'}")
    print(f"Model: {OPENAI_MODEL}")
    print("Authority: READ_ONLY")

    offset = None
    while True:
        try:
            payload = {
                "timeout": POLL_TIMEOUT,
                "allowed_updates": ["message"],
            }
            if offset is not None:
                payload["offset"] = offset

            updates = tg_call(
                "getUpdates",
                payload,
                timeout=POLL_TIMEOUT + 10,
            ) or []

            for update in updates:
                offset = int(update["update_id"]) + 1
                message = update.get("message")
                if message:
                    handle_message(message)

        except KeyboardInterrupt:
            print("Stopped.")
            return
        except Exception as exc:
            print(f"Bridge error: {exc}")
            time.sleep(3)


if __name__ == "__main__":
    main()
