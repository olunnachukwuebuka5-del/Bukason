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
| netlify/functions/gather.js | Server function that gathers and saves knowledge |
| netlify/functions/chat.js | Your existing multi-provider AI chat function (unchanged) |
| setup-knowledge.sql | Creates the `knowledge` table in Supabase |
| supabase-storage-policies.sql | Creates the private `attachments` bucket for image/PDF questions |
| manifest.json, icon-192.png, icon-512.png | Install-to-home-screen files |
| offline-knowledge.json | The 4 starter answers |
| netlify.toml | Netlify settings |

If your repo already has working versions of manifest.json, icons,
netlify.toml or offline-knowledge.json, you can keep yours.

## Setup (once)

1. Supabase -> SQL Editor: run setup-knowledge.sql, then supabase-storage-policies.sql.
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
