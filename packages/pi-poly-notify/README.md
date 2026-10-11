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
- `/notify <seconds>` (set minimum duration threshold)
- `/notify <sound-alias>` (set sound)

## Notes

- Requires Pi 0.84.4 or later; skipping cancelled runs requires Pi 1.1.0 or later
- macOS-only out of the box (uses `osascript` + `afplay`)
- Pushover requires `curl` and valid `userKey` + `apiToken` in config
