// soapbox-server/server.js
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();

app.use(cors());
app.use(express.json());

// Health check (for Render)
app.get('/health', (req, res) => {
  res.status(200).json({ ok: true });
});

// Stories endpoint
app.get('/stories', (req, res) => {
  const file = path.join(__dirname, 'Stories', 'metadata.json');
  if (!fs.existsSync(file)) return res.json([]);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  res.json(data);
});

// Spotlights endpoint
app.get('/spotlights', (req, res) => {
  const file = path.join(__dirname, 'Spotlights', 'metadata.json');
  if (!fs.existsSync(file)) return res.json([]);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  res.json(data);
});

// TODO: add /confessions and /voicemails here later

// Start server
const PORT = process.env.PORT || 3030;
const HOST = '0.0.0.0'; // required for Render
app.listen(PORT, HOST, () => {
  console.log(`Soapbox API running at http://${HOST}:${PORT}`);
});
