import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { body, validationResult } from 'express-validator';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3001;

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(express.json({ limit: '10kb' }));

// Open CORS - widget staat op meerdere domeinen (Framer, synergroen.nl, etc.)
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(rateLimit({ windowMs: 60000, max: 100, standardHeaders: true, legacyHeaders: false }));

app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Chat via Anthropic Claude
app.post('/api/chat',
  [body('messages').isArray({ min: 1 }), body('messages.*.role').isIn(['user','assistant','system']), body('messages.*.content').isString().trim().notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const KEY = process.env.ANTHROPIC_API_KEY;
    if (!KEY) return res.status(503).json({ error: 'AI_OFFLINE' });
    const { messages } = req.body;
    const system = messages.find(m => m.role === 'system')?.content || 'Je bent een assistent voor SynerGroen. Antwoord in het Nederlands.';
    const chat = messages.filter(m => m.role !== 'system');
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001', max_tokens: 1024, stream: true, system, messages: chat.slice(-20) }),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error('Anthropic ' + response.status);
      const dec = new TextDecoder();
      for await (const chunk of response.body) {
        for (const line of dec.decode(chunk, { stream: true }).split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data) continue;
          try {
            const p = JSON.parse(data);
            if (p.type === 'content_block_delta' && p.delta?.text) res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: p.delta.text } }] }) + '\n\n');
            if (p.type === 'message_stop') res.write('data: [DONE]\n\n');
          } catch {}
        }
      }
      res.end();
    } catch (err) { res.write('data: ' + JSON.stringify({ error: 'AI_OFFLINE' }) + '\n\n'); res.end(); }
  }
);

// Pipedrive leads
app.post('/api/leads',
  [body('name').isString().trim().notEmpty(), body('email').isEmail().normalizeEmail()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { name, email, phone, company, message, chatHistory = [] } = req.body;
    const PD = process.env.PIPEDRIVE_API_KEY;
    const BASE = 'https://api.pipedrive.com/v1';
    if (!PD) { console.log('[LEAD]', name, email); return res.json({ success: true, fallback: true }); }
    try {
      const search = await (await fetch(BASE + '/persons/search?term=' + encodeURIComponent(email) + '&fields=email&api_token=' + PD)).json();
      const existing = search?.data?.items?.[0]?.item;
      let personId = existing?.id;
      if (!existing) {
        const pb = { name, email: [{ value: email, primary: true }] };
        if (phone) pb.phone = [{ value: phone, primary: true }];
        personId = (await (await fetch(BASE + '/persons?api_token=' + PD, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pb) })).json())?.data?.id;
        let orgId;
        if (company) {
          orgId = (await (await fetch(BASE + '/organizations?api_token=' + PD, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: company }) })).json())?.data?.id;
          if (orgId) await fetch(BASE + '/persons/' + personId + '?api_token=' + PD, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ org_id: orgId }) });
        }
        const dealId = (await (await fetch(BASE + '/deals?api_token=' + PD, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Lead AI Widget — ' + name, person_id: personId, ...(orgId && { org_id: orgId }) }) })).json())?.data?.id;
        if (dealId) {
          let note = 'Lead SynerGroen AI Widget\n' + new Date().toLocaleString('nl-NL') + '\n\n';
          if (message) note += 'Bericht:\n' + message + '\n\n';
          if (chatHistory.length) note += 'Chat:\n' + chatHistory.map(m => (m.role === 'user' ? 'Bezoeker' : 'AI') + ': ' + m.content).join('\n');
          await fetch(BASE + '/notes?api_token=' + PD, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: note, deal_id: dealId }) });
        }
        return res.json({ success: true, personId, dealId });
      }
      res.json({ success: true, existing: true, personId });
    } catch (err) { console.error('[PD]', err.message); res.status(502).json({ error: 'PIPEDRIVE_ERROR', message: err.message }); }
  }
);

app.use((err, _req, res, _next) => res.status(500).json({ error: 'SERVER_ERROR', message: err.message }));
app.listen(PORT, () => console.log('SynerGroen backend poort ' + PORT));
