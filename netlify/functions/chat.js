// Netlify serverless function — keeps API keys secret on the server.
// The browser never sees them; it only talks to this function.
//
// Strategy: try OpenRouter's free models first (more generous limits).
// If OpenRouter fails or is unavailable, fall back to Gemini.
// This means one provider having a bad day doesn't take the bot down.

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// A few different free models per provider, tried in order — free models
// sometimes get renamed/retired, so a list (not just one) keeps the bot
// working even if one specific model disappears.
const CEREBRAS_MODELS = ['llama-3.3-70b', 'qwen-3-32b', 'llama3.1-8b'];
const OPENROUTER_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemini-2.0-flash-exp:free',
  'deepseek/deepseek-chat-v3.1:free'
];

async function tryCerebras(apiKey, systemPrompt, history) {
  const messages = [
    { role: 'system', content: systemPrompt || '' },
    ...history.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
  ];

  for (const model of CEREBRAS_MODELS) {
    try {
      const response = await fetch('https://api.cerebras.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({ model, messages })
      });
      if (!response.ok) continue;
      const data = await response.json();
      const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (text) return text;
    } catch (e) {
      continue;
    }
  }
  return null;
}

async function tryOpenRouter(apiKey, systemPrompt, history) {
  const messages = [
    { role: 'system', content: systemPrompt || '' },
    ...history.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
  ];

  for (const model of OPENROUTER_MODELS) {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({ model, messages })
      });
      if (!response.ok) continue; // try the next model in the list
      const data = await response.json();
      const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (text) return text;
    } catch (e) {
      continue;
    }
  }
  return null;
}

async function tryGemini(apiKey, systemPrompt, history) {
  const contents = history.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));
  const model = 'gemini-flash-latest';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const delays = [0, 1200];

  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({ contents, system_instruction: { parts: [{ text: systemPrompt || '' }] } })
      });
      if (!response.ok) continue;
      const data = await response.json();
      const text = data.candidates && data.candidates[0] && data.candidates[0].content &&
        data.candidates[0].content.parts && data.candidates[0].content.parts.map(p => p.text || '').join('');
      if (text) return text;
    } catch (e) {
      continue;
    }
  }
  return null;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const cerebrasKey = process.env.CEREBRAS_API_KEY;
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!cerebrasKey && !openRouterKey && !geminiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server is missing AI keys. Add CEREBRAS_API_KEY in Netlify environment variables.' })
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

  try {
    let text = null;

    if (cerebrasKey) {
      text = await tryCerebras(cerebrasKey, systemPrompt, history);
    }
    if (!text && openRouterKey) {
      text = await tryOpenRouter(openRouterKey, systemPrompt, history);
    }
    if (!text && geminiKey) {
      text = await tryGemini(geminiKey, systemPrompt, history);
    }

    if (!text) {
      return {
        statusCode: 503,
        body: JSON.stringify({ error: "All AI services are busy right now. Please try again in a moment." })
      };
    }

    return { statusCode: 200, body: JSON.stringify({ text }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Network error reaching the AI service' }) };
  }
};
