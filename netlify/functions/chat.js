// Netlify serverless function — keeps API keys secret on the server.
// The browser never sees them; it only talks to this function.
//
// Strategy: try Cerebras first (most generous free limits), then
// OpenRouter, then Gemini. Every failure is logged with its real reason
// so problems can actually be diagnosed instead of just showing "busy".

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const CEREBRAS_MODELS = ['gpt-oss-120b', 'llama3.1-70b', 'llama3.1-8b', 'llama-4-scout-17b-16e-instruct'];
const OPENROUTER_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemini-2.0-flash-exp:free',
  'deepseek/deepseek-chat-v3.1:free'
];

async function tryCerebras(apiKey, systemPrompt, history, log) {
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
      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        log.push(`Cerebras/${model}: HTTP ${response.status} ${errBody.slice(0, 150)}`);
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

async function tryOpenRouter(apiKey, systemPrompt, history, log) {
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
      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        log.push(`OpenRouter/${model}: HTTP ${response.status} ${errBody.slice(0, 150)}`);
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
  const delays = [0, 1200];

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
        log.push(`Gemini: HTTP ${response.status} ${errBody.slice(0, 150)}`);
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

  const log = [];

  try {
    let text = null;

    if (cerebrasKey) {
      text = await tryCerebras(cerebrasKey, systemPrompt, history, log);
    }
    if (!text && openRouterKey) {
      text = await tryOpenRouter(openRouterKey, systemPrompt, history, log);
    }
    if (!text && geminiKey) {
      text = await tryGemini(geminiKey, systemPrompt, history, log);
    }

    // Always visible in Netlify's Function log for this request.
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
