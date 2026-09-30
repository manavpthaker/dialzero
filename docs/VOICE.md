# Ask from Siri

Talk to your assistant from your iPhone and hear the answer, without opening Messages. Say
"Hey Siri, ask Juniper" (whatever you named it), ask your question, and it answers out loud.

**How it works:** an iPhone Shortcut turns what you say into text, sends it to your Mac, and speaks the
reply. It's the same assistant and the same conversation as your texts, so "what did I just ask you?"
works across both. Short spoken answers come back within about 25 seconds; anything slower says it's on
it and finishes by text.

**What stays private:** the endpoint listens only on your Mac. Your phone reaches it over Tailscale, a
private network between your own devices. Nothing is opened to the internet, and every request needs a
password only your Shortcut knows.

You need: Tailscale on your Mac and your iPhone, signed into the same account (free for personal use).

## 1. Turn the feature on

In `config/profile.json`, add `"siri": true` under `"modules"` (or set `MODULES_ON=siri` in `.env`).

## 2. Set a password

Make a long random password and put it in `.env`:

```bash
openssl rand -hex 24
```

```
VOICE_TOKEN=<paste it here>
```

Leave `VOICE_PORT=4010` unless something else uses that port. Restart the assistant. The log should
no longer say "VOICE_TOKEN not set".

## 3. Reach it from your phone, privately

Install Tailscale on the Mac and the iPhone and sign both into the same account. Then, on the Mac:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:4010
```

This gives the endpoint a private address only your devices can reach:
`https://<your-mac>.<your-tailnet>.ts.net:8443/voice` (`tailscale serve status` shows it).

**Never use `tailscale funnel` for `/voice`.** Funnel makes a port public. If you set up phone calls
(`docs/PHONE.md`), port 443 is already funneled for the call webhooks, which is why this uses 8443.

## 4. Build the Shortcut

In the Shortcuts app on your iPhone, make a new shortcut with four actions:

1. **Dictate Text.**
2. **Get Contents of URL:**
   - URL: `https://<your-mac>.<your-tailnet>.ts.net:8443/voice`
   - Method: **POST**
   - Headers: `Authorization` = `Bearer <your VOICE_TOKEN>`
   - Request Body: **JSON**, one field: `text` = **Dictated Text**
3. **Get Dictionary Value:** key `reply`, from **Contents of URL**.
4. **Speak Text:** **Dictionary Value**.

Name the shortcut "Ask" plus your assistant's name, so "Hey Siri, ask Juniper" starts it. You can also
put it on your Home Screen or the Action Button.

## 5. Try it

Say "Hey Siri, ask Juniper what's on my calendar tomorrow." You should hear a one to three sentence
answer. If something is wrong, the Shortcut speaks the problem (for example a wrong password) instead of
failing silently, and the Mac's log shows each request.

## Optional: tell it where you are

The same server takes location pings, so the assistant can use "where you are" in its answers (for
example, what's near you). Only you see it: it's used only in your own conversations, never in a family
or shared chat, and each ping is kept for 30 days.

A Shortcut automation (for example, "when I arrive at Work") posts JSON to `/location` with the same
`Authorization` header:

```json
{ "lat": 40.7, "lon": -74.0, "label": "Work", "event": "arrive" }
```

`event` is `arrive`, `leave` or `check`; `address` and `label` are optional.

iPhone automations often can't reach private addresses, so this one path may need to be public. Expose
**only** `/location`, never `/voice`:

```bash
tailscale funnel --bg --https=443 --set-path=/location http://127.0.0.1:4010/location
```

It stays password-protected and can only write a location; it can't read anything back.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `VOICE_TOKEN` | none (feature off) | The password the Shortcut sends. Required. |
| `VOICE_PORT` | `4010` | Port the endpoint listens on (on the Mac only). |
| `VOICE_HOSTS` | `127.0.0.1` | Addresses to listen on. Leave it unless you know you need the Tailscale IP. |
| `VOICE_SYNC_TIMEOUT_MS` | `25000` | How long to wait before saying "on it" and finishing by text. |
