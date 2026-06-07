// test/mock-opencode.js — mimics `opencode serve` for manual E2E of the AI draft feature.
// Usage:
//   node test/mock-opencode.js             # happy path
//   node test/mock-opencode.js --fail500   # every request returns HTTP 500
//   node test/mock-opencode.js --bad-md    # message response is not valid section markdown
const http = require('http');
const FAIL = process.argv.includes('--fail500');
const BAD  = process.argv.includes('--bad-md');
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
function json(res, code, obj){
  res.writeHead(code, {...CORS, 'Content-Type': 'application/json'});
  res.end(JSON.stringify(obj));
}
http.createServer((req, res) => {
  if(req.method === 'OPTIONS'){ res.writeHead(204, CORS); return res.end(); }
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    if(FAIL) return json(res, 500, {error: 'mock failure'});
    if(req.url === '/doc' && req.method === 'GET') return json(res, 200, {openapi: '3.1.0'});
    if(req.url === '/session' && req.method === 'POST') return json(res, 200, {id: 'mock-session-1'});
    if(/^\/session\/[^/]+\/message$/.test(req.url) && req.method === 'POST'){
      const prompt = (JSON.parse(body).parts || []).map(p => p.text || '').join('\n');
      // Echo back the "Current section markdown" part of the prompt with placeholders filled.
      const m = prompt.match(/## Current section markdown[^\n]*\n([\s\S]*?)\n## Output contract/);
      const section = m ? m[1].trim() : '## Unknown';
      const filled = BAD
        ? 'this is not the requested section markdown'
        : section.replace(/_[^_\n|]+_/g, 'Mock value').replace(/YYYY-MM-DD/g, '2026-12-31');
      return json(res, 200, {info: {id: 'msg-1'}, parts: [{type: 'text', text: filled}]});
    }
    json(res, 404, {error: 'not found'});
  });
}).listen(4096, () => console.log(
  'mock opencode on http://127.0.0.1:4096' + (FAIL ? ' (fail500)' : '') + (BAD ? ' (bad-md)' : '')
));
