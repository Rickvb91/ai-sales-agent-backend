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
const PD_TOKEN = process.env.PIPEDRIVE_API_KEY;
const PD_BASE = 'https://api.pipedrive.com/v1';

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(express.json({ limit: '10kb' }));
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(rateLimit({ windowMs: 60000, max: 100, standardHeaders: true, legacyHeaders: false }));

app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ── AI Chat (Anthropic streaming) ─────────────────────────────────────────────
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

// ── Pipedrive Lead (token blijft op server, nooit in browser) ─────────────────
app.post('/api/leads',
  [body('name').isString().trim().notEmpty(), body('email').isEmail().normalizeEmail()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    if (!PD_TOKEN) return res.status(503).json({ error: 'PIPEDRIVE_NOT_CONFIGURED' });

    const { name, email, phone, company, message, chatHistory = [] } = req.body;
    try {
      // 1. Persoon aanmaken
      const personBody = { name, email: [{ value: email, primary: true, label: 'work' }] };
      if (phone) personBody.phone = [{ value: phone, primary: true, label: 'work' }];
      const pr = await fetch(PD_BASE + '/persons?api_token=' + PD_TOKEN, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(personBody)
      });
      const pid = (await pr.json())?.data?.id;
      if (!pid) return res.status(502).json({ error: 'PERSON_FAILED' });

      // 2. Organisatie (optioneel)
      let orgId;
      if (company) {
        const or = await fetch(PD_BASE + '/organizations?api_token=' + PD_TOKEN, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: company })
        });
        orgId = (await or.json())?.data?.id;
        if (orgId) await fetch(PD_BASE + '/persons/' + pid + '?api_token=' + PD_TOKEN, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ org_id: orgId })
        });
      }

      // 3. Deal aanmaken
      const dr = await fetch(PD_BASE + '/deals?api_token=' + PD_TOKEN, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ title: 'Lead AI Widget \u2014 ' + name, person_id: pid, ...(orgId && { org_id: orgId }) })
      });
      const did = (await dr.json())?.data?.id;

      // 4. Note met chatgeschiedenis
      if (did) {
        let note = 'Lead via SynerGroen AI Chat Widget\n' + new Date().toLocaleString('nl-NL') + '\n';
        if (message) note += '\nBericht: ' + message;
        if (chatHistory.length) note += '\n\nChat:\n' + chatHistory.map(m => (m.role === 'user' ? 'Bezoeker' : 'AI') + ': ' + m.content).join('\n');
        await fetch(PD_BASE + '/notes?api_token=' + PD_TOKEN, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: note, deal_id: did })
        });
      }

      res.json({ success: true, personId: pid, dealId: did });
    } catch (err) {
      console.error('[PD]', err.message);
      res.status(502).json({ error: 'PIPEDRIVE_ERROR', message: err.message });
    }
  }
);

app.use((err, _req, res, _next) => res.status(500).json({ error: 'SERVER_ERROR' }));
app.listen(PORT, () => console.log('SynerGroen backend poort ' + PORT));
