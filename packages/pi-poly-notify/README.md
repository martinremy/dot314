# Notifications for Pi (`pi-poly-notify`)

Sends a notification when an agent run that took longer than a configurable threshold finishes, or stops to wait for your answer in a dialog such as a permission prompt. Runs you cancel, for example with Escape, don't send one.

Supports:
- desktop popups (macOS)
- sounds (macOS `afplay`), with plenty of customization options
- optional Pushover notifications (useful for Apple Watch / iOS)

## Install

From npm:

```bash
pi install npm:pi-poly-notify
```

From the dot314 git bundle (filtered install):

Add to `~/.pi/agent/settings.json` (or replace an existing unfiltered `git:github.com/w-winter/dot314` entry):

```json
{
  "packages": [
    {
      "source": "git:github.com/w-winter/dot314",
      "extensions": ["extensions/poly-notify/index.ts"],
      "skills": [],
      "themes": [],
      "prompts": []
    }
  ]
}
```

## Setup

Create your config file:

- copy `notify.json.example` → `notify.json`

Location:

- `~/.pi/agent/extensions/poly-notify/notify.json`

## Usage

- Command: `/notify`
- Shortcut: `Alt+N` (toggle on/off)

Quick forms:
- `/notify on|off`
- `/notify popup` (toggle popup)
- `/notify pushover` (toggle Pushover)
- `/notify volume` (toggle constant ↔ timeScaled)
- `/notify all` (toggle waiting for all Pi sessions)
- `/notify <seconds>` (set minimum duration threshold)
- `/notify <sound-alias>` (set sound)

## Waiting for all Pi sessions

If you run several Pi sessions in parallel, set `"waitForAll": true` in `notify.json` or run `/notify all`. A finished run then notifies only when no other Pi session on this machine is still working, so a single ping tells you everything has stopped. The duration threshold applies to the whole stretch during which at least one session was working, so a short final run still notifies after a long busy period. A dialog that stops a run still notifies right away, because that session can't finish until you answer. The footer shows `∀` while this mode is on, and the setting applies to every session as soon as you change it.

Sessions find each other through small sockets in a per-user folder under your temporary directory. A session's socket exists only while it is working, and sockets left behind by a crashed session are removed the next time another session checks.

## Notes

- Requires Pi 0.84.4 or later; skipping cancelled runs requires Pi 1.1.0 or later
- macOS-only out of the box (uses `osascript` + `afplay`)
- Pushover requires `curl` and valid `userKey` + `apiToken` in config
