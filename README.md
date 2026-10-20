# BUKASON: offline knowledge system

You gather information online. Users' phones sync it automatically.
Offline, the app answers from the copy on the phone.

## Files

| File | What it does |
|---|---|
| index.html | The app (your v8 plus sync, service worker, Sync now button) |
| knowledge-sync.js | Pulls new knowledge from Supabase onto the phone |
| sw.js | Lets the app open with no internet |
| admin.html | Your page for gathering knowledge (needs your admin key) |
| netlify/functions/gather.js | Admin endpoint: stats, users, topic queue, manual gather |
| netlify/functions/auto-gather.js | Runs every 3 minutes and gathers the next queued topic by itself |
| netlify/lib/gather-core.js | Shared code used by both functions above |
| netlify/functions/chat.js | Your chat function. Only change: image questions try 3 Gemini models instead of 1 |
| setup-knowledge.sql | Creates the `knowledge` table in Supabase |
| setup-phase4.sql | Related-word search column and the anonymous search-words table |
| setup-phase3.sql | Index that makes the duplicate check fast |
| setup-phase2.sql | Phone report table (admin sees each account's saved entries) and the pause switch |
| setup-admin.sql | Creates the topic queue table for automatic gathering |
| supabase-storage-policies.sql | Creates the private `attachments` bucket for image/PDF questions |
| manifest.json, icon-192.png, icon-512.png | Install-to-home-screen files |
| offline-knowledge.json | The 4 starter answers |
| netlify.toml | Netlify settings |

If your repo already has working versions of manifest.json, icons,
netlify.toml or offline-knowledge.json, you can keep yours.

## Setup (once)

1. Supabase -> SQL Editor: run setup-knowledge.sql, setup-admin.sql, setup-phase2.sql, setup-phase3.sql, setup-phase4.sql, then supabase-storage-policies.sql.
   Also create the `messages` table if your project has none (see earlier chat).
   Supabase -> Authentication -> URL Configuration: set Site URL to your live site
   (https://bukasonchatsystem.netlify.app) so password-reset emails come back to the app.
2. Upload every file here to the root of your GitHub repo
   (keep gather.js inside netlify/functions/).
3. Netlify -> Site settings -> Environment variables. Add these:
   - ADMIN_KEY: a long secret you invent
   - SUPABASE_URL: your project URL
   - SUPABASE_SERVICE_KEY: the service role key (never put it in a page)
   Keep the AI keys you already use for chat.js: GEMINI_API_KEY,
   GROQ_API_KEY, NVIDIA_API_KEY, OPENROUTER_API_KEY, CEREBRAS_API_KEY.
   gather.js uses the same keys and tries them in that order, so if
   Gemini is busy, a backup writes the entries.
   - GEMINI_MODEL: optional, only if the default model name fails
4. Redeploy.

## Use it

1. Open yourdomain.netlify.app/admin.html, enter your admin key,
   type a topic, tap Gather and save.
2. On any phone: open the app online once, or tap Settings -> Sync now.
3. Go offline and ask about the topic.

## Good to know

- Live web search only works through Gemini. Backups write from the AI's own knowledge.
- If gather times out (Netlify limits how long a function can run), lower the number of entries.
- Phones only have what they synced before going offline.
- Rows you delete in Supabase stay on phones that already synced them.
- Offline answers use keyword matching, so clear wording works best.
- Online chat now calls netlify/functions/chat.js. Each real AI answer
  is also saved on the phone for offline use.
- If the AI is unreachable, the app tries a saved answer before showing an error.
- Images and PDFs now work for logged-in users: the file goes to a private
  Supabase folder, chat.js reads it through a 10-minute link, and the app
  deletes it right after the answer. Guests can ask text questions only.
- Photos are shrunk to about 1600 px before upload to save data.
- Supported: PNG, JPG, WEBP, GIF, HEIC and PDF (up to 15 MB). Word and text
  files are not supported by chat.js.
- File questions are slower. If one times out, try a smaller file.

## New in this version

- Guest mode is gone. Everyone logs in. The login screen has Forgot password.
- Sign-up asks for a name. The admin page lists names (older accounts show "no name given").
- Each chat message is its own box: select-all inside it selects only that message.
  Bot answers also have a Copy button. **bold** and bullets now display properly.
- Admin page: registered people, knowledge count, topic queue, run-now button.
- Automatic gathering: add topics once; the server takes 2 every 6 hours.
- If an image question fails, the chat bubble now shows a small "Details:" line
  from the server. Send that line to whoever is helping you debug.

## General knowledge (all subjects)

- The AI prompt is no longer limited to school or business. "General (any subject)"
  is the default category, and the mixed starter list covers health basics,
  technology, money, history, geography, culture, food, sports and more.
- When the queue runs low, the server suggests new topics by itself, rotating
  through about 20 subject areas. "Let the AI suggest new topics" does it on demand.
- Automatic gathering pauses at 3,000 entries because each phone keeps a copy in
  its storage. You can still gather manually past that.
- For health, legal and money topics the AI is told to give general information
  only. Read a sample of the entries in Supabase before relying on them.

## Phase 2: unlimited phone storage, admin visibility, faster gathering

- Phones now keep knowledge in IndexedDB (large browser storage) instead of localStorage,
  so there is no 3,000 entry limit. Old saved knowledge moves over by itself.
- A word index keeps offline answers fast however many entries are saved.
- Matching ignores filler words ("what is a ..."), so unrelated questions no longer
  get a wrong saved answer.
- Users no longer see how many entries are stored. The admin page shows, for each
  account, how many entries its phone holds and when it last synced.
- Automatic gathering runs every 3 minutes (1 topic per run), with a Pause button on the admin page.
  See Phase 3 below for how it slows down and stops.
- Watch two limits: Supabase free database size (500 MB) and the size of a new
  user's first sync. Both grow with the number of entries.

## Phase 3: keeping the database and downloads small

- Gathering speed follows how much is saved: every 3 minutes until AUTO_FAST_UNTIL
  entries (default 10,000), about once an hour until AUTO_ENTRY_LIMIT (default 30,000),
  then it stops. Set either number in Netlify to change it.
- Near-duplicate questions ("Explain what rain is" vs "What is rain?") are skipped.
  Run setup-phase3.sql once so the check stays fast.
- Phones on mobile data (or when the connection type is unknown) download at most
  about 1.5 MB a day automatically, oldest and most useful entries first, and carry on
  the next day. On Wi-Fi the phone downloads everything. Sync now downloads everything
  after asking if a big amount is left and the phone may be on mobile data.
- Starter topics were gathered first, so new users receive them first.

## Phase 4: entries follow what people search

- When someone searches (online), their phone also downloads saved entries related to
  those words, then entries related to the words those results use. Entries the phone
  already holds are left out, so each search brings new ones. Related downloads on
  mobile data are capped at about 400 KB a day; Wi-Fi is unlimited; Data saver stops them.
  The AI's own answers are still saved on the phone too.
- Anonymous search words: after login each person is asked once whether to share them
  (Settings has a switch). If allowed, and no saved answer matched, only key words
  (letters only, up to 6, no account, no name) are sent. Words that 2 or more people
  searched are queued as topics automatically; the admin page lists them. Nothing is
  kept longer than 30 days. Set DEMAND_MIN in Netlify to change the "2".
- Run setup-phase4.sql once. It adds the search column and the table.

## Install banner

- Browsers cannot install an app silently. When the site opens, a banner offers
  "Install BUKASON on your phone". One tap installs it and the icon appears on the home
  screen within a few seconds. "Not now" hides it for a week.
- Settings has an "Install app on this phone" button for anyone who dismissed it.
- iPhones cannot be prompted by any website, so Safari users see the steps instead:
  Share, then Add to Home Screen.
- Nothing shows if the app is already installed.
