// Netlify serverless function — keeps API keys secret on the server.
//
// Strategy (in order, per which keys are set — see handler below):
//  1. Gemini — retried a couple of times in case of a brief overload.
//  2. NVIDIA NIM / Cloudflare Workers AI / Groq — additional fallbacks.
//  3. Mistral (La Plateforme) — permanent free tier, added as a backup
//     since Groq's signup flow has had intermittent issues.
//  4. OpenRouter — discovers CURRENTLY free models at request time instead
//     of using hardcoded names, since free models rotate/get deprecated often.
//  5. Cerebras — last resort (its free daily tier ended July 2026; it may
//     still work if trial/paid credits are available).
//
// Every failure is logged with its real reason so problems can be diagnosed
// from the response itself, not just a generic "busy" message.

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// In-memory cache (survives while this function stays "warm" between
// requests) so we don't re-fetch OpenRouter's model list on every message.
let cachedFreeModels = null;
let cacheTime = 0;
const CACHE_MS = 10 * 60 * 1000; // 10 minutes

async function getOpenRouterFreeModels(apiKey, log) {
  const now = Date.now();
  if (cachedFreeModels && (now - cacheTime) < CACHE_MS) {
    return cachedFreeModels;
  }
  try {
    const resp = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    if (!resp.ok) {
      log.push(`OpenRouter model list: HTTP ${resp.status}`);
      return cachedFreeModels || [];
    }
    const data = await resp.json();
    const freeModels = (data.data || [])
      .filter(m => m.id && m.id.endsWith(':free'))
      .map(m => m.id);

    // Put well-known, generally-reliable families first when present.
    const priority = ['llama', 'gemma', 'mistral', 'qwen', 'deepseek'];
    freeModels.sort((a, b) => {
      const ai = priority.findIndex(p => a.includes(p));
      const bi = priority.findIndex(p => b.includes(p));
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    cachedFreeModels = freeModels;
    cacheTime = now;
    return freeModels;
  } catch (e) {
    log.push(`OpenRouter model list fetch error: ${e.message}`);
    return cachedFreeModels || [];
  }
}

async function tryOpenRouter(apiKey, systemPrompt, history, log) {
  const messages = [
    { role: 'system', content: systemPrompt || '' },
    ...history.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
  ];

  let models = await getOpenRouterFreeModels(apiKey, log);
  if (models.length === 0) {
    // Fallback guesses only used if live discovery itself fails.
    models = ['meta-llama/llama-3.2-3b-instruct:free', 'google/gemma-2-9b-it:free'];
  }

  for (const model of models.slice(0, 6)) {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({ model, messages })
      });
      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        log.push(`OpenRouter/${model}: HTTP ${response.status} ${errBody.slice(0, 130)}`);
        continue;
      }
      const data = await response.json();
      const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (text) return text;
      log.push(`OpenRouter/${model}: empty response`);
    } catch (e) {
      log.push(`OpenRouter/${model}: ${e.message}`);
    }
  }
  return null;
}

async function tryGemini(apiKey, systemPrompt, history, log) {
  const contents = history.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));
  const model = 'gemini-2.5-flash-lite'; // 1,000 free requests/day — the reliable one
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const delays = [0, 1200, 2500];

  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({ contents, system_instruction: { parts: [{ text: systemPrompt || '' }] } })
      });
      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        log.push(`Gemini: HTTP ${response.status} ${errBody.slice(0, 130)}`);
        continue;
      }
      const data = await response.json();
      const text = data.candidates && data.candidates[0] && data.candidates[0].content &&
        data.candidates[0].content.parts && data.candidates[0].content.parts.map(p => p.text || '').join('');
      if (text) return text;
      log.push(`Gemini: empty response`);
    } catch (e) {
      log.push(`Gemini: ${e.message}`);
    }
  }
  return null;
}

async function tryNvidia(apiKey, systemPrompt, history, log) {
  const messages = [
    { role: 'system', content: systemPrompt || '' },
    ...history.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
  ];
  const models = ['meta/llama-3.1-8b-instruct', 'mistralai/mixtral-8x7b-instruct-v0.1'];

  for (const model of models) {
    try {
      const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages })
      });
      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        log.push(`NVIDIA/${model}: HTTP ${response.status} ${errBody.slice(0, 130)}`);
        continue;
      }
      const data = await response.json();
      const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (text) return text;
      log.push(`NVIDIA/${model}: empty response`);
    } catch (e) {
      log.push(`NVIDIA/${model}: ${e.message}`);
    }
  }
  return null;
}

async function tryGroq(apiKey, systemPrompt, history, log) {
  const messages = [
    { role: 'system', content: systemPrompt || '' },
    ...history.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
  ];
  const models = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'gemma2-9b-it'];

  for (const model of models) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages })
      });
      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        log.push(`Groq/${model}: HTTP ${response.status} ${errBody.slice(0, 130)}`);
        continue;
      }
      const data = await response.json();
      const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (text) return text;
      log.push(`Groq/${model}: empty response`);
    } catch (e) {
      log.push(`Groq/${model}: ${e.message}`);
    }
  }
  return null;
}

async function tryMistral(apiKey, systemPrompt, history, log) {
  const messages = [
    { role: 'system', content: systemPrompt || '' },
    ...history.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
  ];
  const models = ['mistral-small-latest', 'open-mistral-nemo'];

  for (const model of models) {
    try {
      const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages })
      });
      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        log.push(`Mistral/${model}: HTTP ${response.status} ${errBody.slice(0, 130)}`);
        continue;
      }
      const data = await response.json();
      const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (text) return text;
      log.push(`Mistral/${model}: empty response`);
    } catch (e) {
      log.push(`Mistral/${model}: ${e.message}`);
    }
  }
  return null;
}

async function tryCloudflare(accountId, apiToken, systemPrompt, history, log) {
  const messages = [
    { role: 'system', content: systemPrompt || '' },
    ...history.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
  ];
  const models = ['@cf/meta/llama-3.1-8b-instruct', '@cf/meta/llama-3-8b-instruct'];
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;

  for (const model of models) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiToken}` },
        body: JSON.stringify({ model, messages })
      });
      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        log.push(`Cloudflare/${model}: HTTP ${response.status} ${errBody.slice(0, 130)}`);
        continue;
      }
      const data = await response.json();
      const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (text) return text;
      log.push(`Cloudflare/${model}: empty response`);
    } catch (e) {
      log.push(`Cloudflare/${model}: ${e.message}`);
    }
  }
  return null;
}

async function tryCerebras(apiKey, systemPrompt, history, log) {
  const messages = [
    { role: 'system', content: systemPrompt || '' },
    ...history.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
  ];
  // Current production model per Cerebras docs — others require paid/dedicated access.
  const models = ['gpt-oss-120b'];

  for (const model of models) {
    try {
      const response = await fetch('https://api.cerebras.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages })
      });
      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        log.push(`Cerebras/${model}: HTTP ${response.status} ${errBody.slice(0, 130)}`);
        continue;
      }
      const data = await response.json();
      const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (text) return text;
      log.push(`Cerebras/${model}: empty response`);
    } catch (e) {
      log.push(`Cerebras/${model}: ${e.message}`);
    }
  }
  return null;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const openRouterKey = process.env.OPENROUTER_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  const cerebrasKey = process.env.CEREBRAS_API_KEY;
  const nvidiaKey = process.env.NVIDIA_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;
  const mistralKey = process.env.MISTRAL_API_KEY;
  const cfAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const cfApiToken = process.env.CLOUDFLARE_API_TOKEN;

  if (!openRouterKey && !geminiKey && !cerebrasKey && !nvidiaKey && !groqKey && !mistralKey && !(cfAccountId && cfApiToken)) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server is missing AI keys. Add OPENROUTER_API_KEY in Netlify environment variables.' })
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Bad request body' }) };
  }

  const { systemPrompt, history } = payload;
  if (!Array.isArray(history) || history.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing conversation history' }) };
  }

  const log = [];

  try {
    let text = null;

    // Order: Gemini (1,000/day, most reliable) -> NVIDIA NIM (no daily cap)
    // -> Cloudflare Workers AI (~200-400/day, different infra) -> Groq
    // -> Mistral (permanent free tier backup) -> OpenRouter (small backup)
    // -> Cerebras (last resort).
    if (geminiKey) {
      text = await tryGemini(geminiKey, systemPrompt, history, log);
    }
    if (!text && nvidiaKey) {
      text = await tryNvidia(nvidiaKey, systemPrompt, history, log);
    }
    if (!text && cfAccountId && cfApiToken) {
      text = await tryCloudflare(cfAccountId, cfApiToken, systemPrompt, history, log);
    }
    if (!text && groqKey) {
      text = await tryGroq(groqKey, systemPrompt, history, log);
    }
    if (!text && mistralKey) {
      text = await tryMistral(mistralKey, systemPrompt, history, log);
    }
    if (!text && openRouterKey) {
      text = await tryOpenRouter(openRouterKey, systemPrompt, history, log);
    }
    if (!text && cerebrasKey) {
      text = await tryCerebras(cerebrasKey, systemPrompt, history, log);
    }

    console.log('BUKASON chat attempt log:', JSON.stringify(log));

    if (!text) {
      return {
        statusCode: 503,
        body: JSON.stringify({
          error: "All AI services are busy right now. Please try again in a moment.",
          debug: log
        })
      };
    }

    return { statusCode: 200, body: JSON.stringify({ text }) };
  } catch (err) {
    console.log('BUKASON chat fatal error:', err.message, JSON.stringify(log));
    return { statusCode: 500, body: JSON.stringify({ error: 'Network error reaching the AI service', debug: log }) };
  }
};
        
