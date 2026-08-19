// Netlify serverless function — keeps API keys secret on the server.
//
// Strategy (in order):
//  1. OpenRouter — discovers CURRENTLY free models at request time instead of
//     using hardcoded names, since free models rotate/get deprecated often.
//  2. Gemini — retried a couple of times in case of a brief overload.
//  3. Cerebras — last resort (its free daily tier ended July 2026; it may
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
  const model = 'gemini-flash-latest';
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

  if (!openRouterKey && !geminiKey && !cerebrasKey) {
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

    if (openRouterKey) {
      text = await tryOpenRouter(openRouterKey, systemPrompt, history, log);
    }
    if (!text && geminiKey) {
      text = await tryGemini(geminiKey, systemPrompt, history, log);
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
