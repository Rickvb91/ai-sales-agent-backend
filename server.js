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

app.use(helmet());
app.use(express.json({ limit: '10kb' }));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',');
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error('CORS geblokkeerd voor: ' + origin));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

const limiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
app.use(limiter);

app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.post('/api/chat',
  [
    body('messages').isArray({ min: 1 }),
    body('messages.*.role').isIn(['user', 'assistant', 'system']),
    body('messages.*.content').isString().trim().notEmpty(),
    body('collection_name').optional().isString().trim(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { messages, collection_name } = req.body;
    const openWebUIUrl = process.env.OPEN_WEBUI_URL;

    if (!openWebUIUrl) {
      return res.status(503).json({ error: 'AI_OFFLINE', message: 'AI-backend niet beschikbaar.' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const reqBody = { model: process.env.OPEN_WEBUI_MODEL || 'llama3', messages, stream: true };
    if (collection_name) reqBody.collection_name = collection_name;

    try {
      const aiResponse = await fetch(openWebUIUrl + '/api/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (process.env.OPEN_WEBUI_API_KEY || ''),
        },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(30000),
      });

      if (!aiResponse.ok) throw new Error('Open WebUI HTTP ' + aiResponse.status);

      for await (const chunk of aiResponse.body) {
        res.write(chunk.toString());
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      console.error('[CHAT ERROR]', err.message);
      res.write('data: ' + JSON.stringify({ error: 'AI_OFFLINE', message: err.message }) + '\n\n');
      res.end();
    }
  }
);

app.post('/api/leads',
  [
    body('name').isString().trim().notEmpty(),
    body('email').isEmail().normalizeEmail(),
    body('phone').optional().isMobilePhone(),
    body('company').optional().isString().trim(),
    body('message').optional().isString().trim(),
    body('chatHistory').optional().isArray(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { name, email, phone, company, message, chatHistory = [] } = req.body;
    const PIPEDRIVE_API_KEY = process.env.PIPEDRIVE_API_KEY;
    const PD_BASE = 'https://api.pipedrive.com/v1';

    if (!PIPEDRIVE_API_KEY) {
      console.log('[LEAD FALLBACK]', { name, email });
      return res.json({ success: true, fallback: true });
    }

    try {
      const searchRes = await fetch(PD_BASE + '/persons/search?term=' + encodeURIComponent(email) + '&fields=email&api_token=' + PIPEDRIVE_API_KEY);
      const searchData = await searchRes.json();
      const existing = searchData?.data?.items?.[0]?.item;

      let personId;
      if (existing) {
        personId = existing.id;
      } else {
        const personBody = { name, email: [{ value: email, primary: true }] };
        if (phone) personBody.phone = [{ value: phone, primary: true }];
        const personRes = await fetch(PD_BASE + '/persons?api_token=' + PIPEDRIVE_API_KEY, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(personBody)
        });
        const personData = await personRes.json();
        personId = personData?.data?.id;

        let orgId;
        if (company) {
          const orgRes = await fetch(PD_BASE + '/organizations?api_token=' + PIPEDRIVE_API_KEY, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: company })
          });
          orgId = (await orgRes.json())?.data?.id;
          if (orgId) await fetch(PD_BASE + '/persons/' + personId + '?api_token=' + PIPEDRIVE_API_KEY, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ org_id: orgId })
          });
        }

        const dealRes = await fetch(PD_BASE + '/deals?api_token=' + PIPEDRIVE_API_KEY, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'Lead via AI Widget — ' + name, person_id: personId, ...(orgId && { org_id: orgId }) })
        });
        const dealId = (await dealRes.json())?.data?.id;

        if (dealId) {
          let note = '📋 Lead via AI Widget\n🕐 ' + new Date().toLocaleString('nl-NL') + '\n\n';
          if (message) note += '💬 Bericht:\n' + message + '\n\n';
          if (chatHistory.length) note += '🤖 Chat:\n' + chatHistory.map(m => (m.role === 'user' ? '👤' : '🤖') + ': ' + m.content).join('\n');
          await fetch(PD_BASE + '/notes?api_token=' + PIPEDRIVE_API_KEY, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: note, deal_id: dealId })
          });
        }
        return res.json({ success: true, personId, dealId });
      }
      res.json({ success: true, existing: true, personId });
    } catch (err) {
      res.status(502).json({ error: 'PIPEDRIVE_ERROR', message: err.message });
    }
  }
);

app.use((err, _req, res, _next) => res.status(500).json({ error: 'SERVER_ERROR', message: err.message }));

app.listen(PORT, () => console.log('🚀 Backend draait op port ' + PORT));
