const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'ok', hasKey: !!process.env.ANTHROPIC_API_KEY, ts: Date.now() });
});

app.post('/api/claude', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.error('No ANTHROPIC_API_KEY set');
    return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY not configured on server.' } });
  }

  // Log what we are sending
  console.log('Calling Anthropic, model:', req.body && req.body.model);
  console.log('Key prefix:', apiKey.substring(0, 20));

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });

    const text = await upstream.text();
    console.log('Anthropic status:', upstream.status);
    console.log('Anthropic response:', text.substring(0, 300));

    let data;
    try { data = JSON.parse(text); } catch(e) { data = { raw: text }; }

    res.status(upstream.status).json(data);

  } catch (err) {
    console.error('Proxy fetch error:', err.message);
    res.status(500).json({ error: { message: err.message } });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('AlphaSignal running on port', PORT);
  console.log('API key set:', !!process.env.ANTHROPIC_API_KEY);
  console.log('API key prefix:', process.env.ANTHROPIC_API_KEY ? process.env.ANTHROPIC_API_KEY.substring(0, 20) : 'NONE');
});
