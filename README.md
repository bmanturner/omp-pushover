# omp-pushover

Get a phone notification when an omp agent finishes, stops with an error, or needs your input, but only when you are away from your Mac.

> [!IMPORTANT]
> **macOS only.** Credentials come from the macOS login Keychain (`/usr/bin/security`). Presence is read with macOS tools (`ioreg`, `pgrep ScreenSaverEngine`, `stat /dev/console`). On any other OS the extension finds no credentials and never sends.

## What it does

Long agent turns are easy to walk away from. This project sends a [Pushover](https://pushover.net) notification when a turn ends, but stays quiet while you are using the Mac. It has two parts:

- **An omp extension** (`src/`). It watches the main agent's turns, decides whether you are away, and sends.
- **A Tern window plugin** (`tern-plugin/`). It adds palette commands and a status-line segment. This part is optional.

A notification looks like this:

```
omp · my-project
Finished: Refactor the session loader (12m)
```

It carries only the project folder, the session name and the duration. Model output and questions are never sent.

## Requirements

- macOS
- omp, which runs the extension with Bun
- A [Pushover](https://pushover.net) account and the Pushover app on your phone
- Optional: Tern, for the plugin and for detecting whether the agent's pane is on screen

## Installation

1. **Create a Pushover application.** Go to <https://pushover.net/apps/build> to get an app token, then copy your user key from the Pushover dashboard.

2. **Store both in the login Keychain.** Each command prompts for the value, so it stays out of your shell history:

   ```sh
   security add-generic-password -U -s omp-pushover -a app-token -w
   security add-generic-password -U -s omp-pushover -a user-key -w
   ```

3. **Load the extension.** Add this to `~/.omp/agent/config.yml`, using the path where you cloned the repository:

   ```yaml
   extensions:
     - ~/Dev/personal/omp-pushover
   ```

4. **Link the Tern plugin** (optional):

   ```sh
   tern plugin link ~/Dev/personal/omp-pushover/tern-plugin
   ```

5. **Check delivery.** Start a new omp session; its status line should show `push: auto`. Then run:

   ```
   /push test
   ```

## Usage

### In omp

|Command|Effect|
|---|---|
|`/push` or `/push status`|Shows the mode, time left, whether this session is armed, credentials, the last error and the last decision|
|`/push auto` · `always` · `off`|Sets the mode and clears any away or snooze|
|`/push away [dur]`|Sends without waiting to see if you are idle (default `4h`)|
|`/push snooze [dur]`|Sends nothing, even for an armed session (default `1h`)|
|`/push arm`|Sends when this session's next turn ends, at once, whatever the mode and whether or not you are at the Mac|
|`/push disarm`|Removes this session's arm|
|`/push test`|Sends a test notification, ignoring the rules|

Durations look like `30m` or `2h`. For example, `/push away 90m` before stepping out.

The status line shows the current state: `push: auto`, `push: away 3h12m`, `push: snoozed 45m`, `push: off`. It adds `· armed` or `· error` when either applies.

### In Tern

The command palette has a **Phone push** group:

- Phone push: Auto · Always · Off
- Phone push: Away for 4 hours
- Phone push: Snooze for 1 hour
- Phone push: Notify me when this agent finishes (arms the focused pane)
- Phone push: Cycle mode

The status-line segment shows the same `push: …` text. Clicking it cycles auto → always → off. omp sees changes made in Tern within 15 seconds.

## How it decides

|Mode|Behaviour|
|---|---|
|`auto` (default)|Sends only if you look away (below)|
|`always`|Sends at every turn end|
|`away`|Like `always`, until the timer runs out|
|`off`|Sends nothing unless the session or pane is armed|
|`snooze`|Sends nothing, armed or not|

In `auto`:

1. Turns under 60 seconds are skipped.
2. The extension sends at once if the screen is locked, the screensaver is running, or another user has the console.
3. Otherwise it waits 60 seconds (30 for needs-input). It then sends only if there has been no keyboard or mouse input for 60 seconds.
4. If the agent's Tern pane is on screen, it needs 300 seconds of no input instead (120 for needs-input).
5. A notification still undecided after 30 minutes is dropped.

`always` and `away` also skip turns under 60 seconds.

An arm (`/push arm`, or "Notify me when this agent finishes" in Tern) sends as soon as that agent's next turn ends or stops with an error. It ignores the mode, the turn's length and whether you are at the Mac. Only `snooze` blocks it. The arm is used up when it sends.

Needs-input notifications are sent at Pushover priority 1, so they get through Pushover's quiet hours. The rest use priority 0.

> [!NOTE]
> Closing the lid sleeps the Mac and pauses the agents. Nothing is sent until it wakes.

## How it works

|File|Role|
|---|---|
|`src/index.ts`|omp event handlers, the wait timer and the `/push` command|
|`src/policy.ts`|The decision rules, as pure functions|
|`src/presence.ts`|Idle time, lock, screensaver, console user and Tern pane visibility|
|`src/pushover.ts`|Keychain credentials, sending with retries, message text|
|`src/state.ts`|The shared state file|
|`tern-plugin/`|The Tern window plugin (Luau)|

The extension and the plugin share `~/.config/omp-pushover/state.json`:

```json
{ "mode": "auto", "away_until": null, "snooze_until": null, "armed": [], "last_error": null }
```

Times are Unix seconds. A missing or invalid file means the defaults.

## Troubleshooting

- **No `push:` in omp's status line.** The extension did not load. omp loads extensions only when it starts, so sessions that were already running when you installed it never run it; restart them. Otherwise check the path in `config.yml`, then look in `~/.omp/logs/` for the load error.
- **`/push status` says credentials are missing.** Run the two `security` commands again. Check them with `security find-generic-password -s omp-pushover -a app-token -w`.
- **`· error` in the status line.** `/push status` shows the last error. Errors are cleared by the next successful send.
- **Nothing arrives while you are away.** `/push status` shows the last decision and its reason, such as `dropped (short turn)` or `wait 50s (present …)`.

## Uninstall

1. Remove the entry from `extensions:` in `~/.omp/agent/config.yml`.
2. Unlink the plugin and delete the state and credentials:

```sh
tern plugin unlink omp-pushover
rm -r ~/.config/omp-pushover
security delete-generic-password -s omp-pushover -a app-token
security delete-generic-password -s omp-pushover -a user-key
```

## Development

```sh
bun test
```

The tests cover the decision rules and the status text. There are no dependencies.

## License

[MIT](LICENSE)
