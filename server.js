// server.js — Blue Collar Soapbox API (S3 witness route mounted)
const express = require('express');
const cors = require('cors');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ✅ Mount S3 witness router under /api
app.use('/api', require('./routes/witness-s3'));

// Simple health
app.get('/health', (_req, res) => res.json({ ok: true }));

// 404 & error handling
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _req, res, _next) => {
  console.error('API error:', err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

const PORT = Number(process.env.PORT) || 3030;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`API listening on :${PORT}`);
});
