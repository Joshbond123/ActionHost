import express from 'express';

const app = express();
const port = Number(process.env.PORT || 3000);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'ActionHost API', tunnel_provider: 'ngrok' });
});

app.listen(port, () => {
  console.log(`ActionHost helper API listening on ${port}`);
});
