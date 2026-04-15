const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Proxy endpoint — forwards to Anthropic, injects API key from env or request header
app.post('/api/claude', async (req, res) => {
  try {
    // Accept key from request header (sent by browser) OR from server env variable
    const apiKey = req.headers['x-api-key'] || process.env.ANTHROPIC_API_KEY || '';

    if (!apiKey || apiKey.length < 10) {
      return res.status(401).json({ error: { message: 'No API key provided. Please set your key in the app.' } });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(500).json({ error: { message: 'Proxy server error: ' + err.message } });
  }
});

// Fallback — serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`AlphaSignal server running on port ${PORT}`);
});
