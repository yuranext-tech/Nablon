// Safe quarantine for the legacy test deployment.
// The PostgreSQL endpoint is unavailable and this branch contained a sensitive
// /debug endpoint. Keep the HTTP service alive without loading legacy bot code,
// database migrations, Telegram polling, or any user data.
const http = require('http');
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('legacy test service quarantined');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
}).listen(port, () => console.log('Legacy test service quarantined on port', port));
