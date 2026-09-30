# Phone calls, errands and wake-up calls

With this set up, your assistant can:
- take your calls (call its number and talk to it),
- call you (wake-up calls, "call me"),
- call businesses for you ("call the dentist and move my cleaning") and handle phone menus,
- answer when a business calls back about an errand.

**Needs an OpenAI API key**, even if Claude runs the rest of your assistant: calls use OpenAI's real-time voice model. Put it in `.env` as `OPENAI_API_KEY`. (When you talk to it on the phone and ask about your day, the answer still comes from your main assistant, Claude or OpenAI.)

**How it works:** your assistant gets a phone number from Twilio. Twilio connects each call straight to OpenAI's voice model, so no audio passes through your Mac. Your Mac only receives two small, signed notifications per call ("a call is starting", "here's what happened"). For those it needs a public web address, which Tailscale Funnel provides for free.

**Cost:** a Twilio number is a small monthly fee, plus per-minute charges for calls, plus OpenAI's voice model usage. Check Twilio's and OpenAI's current pricing.

Time: about 30 minutes.

## 1. Get a Twilio number

1. Sign up at https://www.twilio.com and upgrade from the trial (trial accounts can only call verified numbers and play a trial message).
2. **Phone Numbers → Buy a number**: pick a local number with **Voice** capability.
3. From the Twilio console home page, note your **Account SID** and **Auth Token**.

Put these in `.env`:
```
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_NUMBER=+15551234567
```

## 2. Give your Mac a public address (Tailscale Funnel)

1. Install Tailscale (https://tailscale.com/download/mac) and sign in.
2. In the Tailscale admin console, enable **HTTPS certificates** and **Funnel** for your tailnet (Settings → Feature previews / DNS; the Funnel docs link walks you through it).
3. Expose only the two paths the phone needs, on port 443 (OpenAI only delivers webhooks to the standard HTTPS port):
   ```
   tailscale funnel --bg --https=443 --set-path=/openai/webhook http://127.0.0.1:4011/openai/webhook
   tailscale funnel --bg --https=443 --set-path=/twilio/voice http://127.0.0.1:4011/twilio/voice
   ```
4. `tailscale funnel status` shows your public address, like `https://your-mac.your-tailnet.ts.net`. Put it in `.env`:
   ```
   PHONE_PUBLIC_URL=https://your-mac.your-tailnet.ts.net
   ```

Only those two paths are public, and each request is checked against Twilio's or OpenAI's signature. Everything else on your Mac stays private.

## 3. Point Twilio at your Mac

Twilio console → your number → **Voice configuration**:
- **A call comes in:** Webhook, `https://your-mac.your-tailnet.ts.net/twilio/voice`, HTTP **POST**.
- Save.

## 4. Connect OpenAI's voice model

1. OpenAI dashboard → **Settings → Project → General**: copy the **Project ID** (`proj_...`). It must be the same project your `OPENAI_API_KEY` belongs to.
2. **Settings → Project → Webhooks → Create**: URL `https://your-mac.your-tailnet.ts.net/openai/webhook`, event **realtime.call.incoming**. Copy the signing secret right away; it's shown once.
3. Use **Send test event** to check delivery.

```
OPENAI_PROJECT_ID=proj_...
OPENAI_WEBHOOK_SECRET=whsec_...
```

## 5. Restart and test

`npm run restart`, then `npm run doctor -- --setup` should show phone as ok.

- **Call the assistant's number from your phone.** Only your number gets through. Your carrier must mark your caller ID as verified (most US carriers do); if you're rejected, set `PHONE_REQUIRE_VERIFIED_CALLER=false`.
- Text it: **"call me"**.
- Text it: **"wake me up in 2 minutes"** and answer when it rings.

## Make wake-up calls ring on silent (iPhone)

Save the assistant's number as a contact. Open the contact → **Edit → Ringtone** → turn on **Emergency Bypass**, and pick a loud ringtone. Only its calls will ring when your phone is on silent.

## Settings worth knowing

| Setting | Default | What it does |
|---|---|---|
| `PHONE_VOICE` | `marin` | The voice (try `echo`, `cedar`, `marin`). |
| `PHONE_REQUIRE_VERIFIED_CALLER` | `true` | Only accept your calls when your carrier verifies your caller ID. |
| `ERRAND_CALL_START` / `ERRAND_CALL_END` | `9` / `18` | Hours (local time, Mon–Sat) it calls businesses. |
| `ERRAND_DAILY_CALL_CAP` | `10` | Max calls to businesses per day. |
| `WAKEUP_RETRY_MIN` / `WAKEUP_MAX_ATTEMPTS` | `3` / `7` | Wake-up calls retry every 3 minutes for about 20 minutes. |

## Rules it follows on calls

- Introduces itself as your assistant by the name you gave it, and says plainly it's an AI whenever asked. It never claims to be you.
- Shares only the details you approved for that call.
- Never gives card, bank, ID or password details, and never agrees to charges.
- Calls businesses only. Calling a person needs their OK first (US rules require consent for AI-voice calls to personal phones).
- Keeps only the outcome of a call unless you say "keep transcript".
