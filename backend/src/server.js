import 'dotenv/config'
import http from 'node:http'
import cors from 'cors'
import express from 'express'
import { GoogleGenAI, Modality } from '@google/genai'
import { WebSocketServer } from 'ws'

const app = express()
const port = process.env.PORT || 3001
const frontendOrigins = new Set([
  ...(process.env.FRONTEND_ORIGINS || process.env.FRONTEND_ORIGIN || 'http://127.0.0.1:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  'http://localhost:5173',
  'http://127.0.0.1:5173',
])
const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash'
const liveModel = process.env.GEMINI_LIVE_MODEL || "gemini-3.1-flash-live-preview"

app.use(
  cors({
    origin: [...frontendOrigins],
  }),
)
app.use(express.json({ limit: '1mb' }))

function buildGuidePrompt(entity) {
  return `
Tu es l'assistant universitaire de L'universite nouveaux horizons (UNH), un guide vocal clair, chaleureux et utile.
Tu aides les visiteurs, les etudiants et les parents a comprendre l'entite "${entity.nom}".

Regles importantes:
- Au debut de la session, attends que l'utilisateur te parle avant de repondre.
- Si l'utilisateur dit bonjour, salue-le puis propose de l'aider sur cette entite.
- Base-toi uniquement sur le contenu fourni plus bas.
- N'invente pas de faits, de noms, de dates, d'adresses ou de details absents du contenu.
- Si la reponse n'est pas dans le contexte, dis clairement que tu n'as pas cette information.
- Ne recite pas le contexte mot pour mot: reformule naturellement.
- Reponds en francais simple, direct et bienveillant.
- Tu representes l'universite, donc garde un ton professionnel et accueillant.

Type d'entite: ${entity.type || 'non precise'}
Description courte visible dans l'interface:
${entity.description || 'Non fournie'}

Contexte complet reserve a l'assistant:
${entity.fullDescription}
`.trim()
}

function sendJson(ws, data) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data))
  }
}

function validateEntity(entity) {
  return entity?.nom && entity?.fullDescription
}

app.get('/health', (req, res) => {
  res.json({ ok: true })
})

app.post('/api/guide', async (req, res) => {
  const { entity } = req.body

  if (!validateEntity(entity)) {
    return res.status(400).json({
      error: "Le nom et la fullDescription de l'entite sont obligatoires.",
    })
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY manque dans backend/.env.',
    })
  }

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
    const response = await ai.models.generateContent({
      model,
      contents: buildGuidePrompt(entity),
    })

    res.json({ text: response.text })
  } catch (error) {
    console.error('Erreur Gemini:', error)
    res.status(500).json({
      error: "Impossible de contacter Gemini pour l'instant.",
    })
  }
})

const server = http.createServer(app)
const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`)

  if (pathname !== '/guide-live') {
    console.log(`[Nova UNH WS] Upgrade refuse, route inconnue: ${pathname}`)
    socket.destroy()
    return
  }

  if (request.headers.origin && !frontendOrigins.has(request.headers.origin)) {
    console.log(`[Nova UNH WS] Upgrade refuse, origin non autorisee: ${request.headers.origin}`)
    socket.destroy()
    return
  }

  console.log(`[Nova UNH WS] Upgrade accepte depuis ${request.headers.origin || 'origin inconnue'}`)
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws)
  })
})

wss.on('connection', (clientWs) => {
  console.log('[Nova UNH WS] Client connecte au backend.')
  let liveSession = null
  let isGeminiReady = false
  let hasReceivedGeminiChunk = false
  let isFallbackRunning = false
  let currentEntity = null
  let currentQuestion = ''
  let audioInputCount = 0
  const pendingMessages = []

  async function streamTextFallback() {
    if (isFallbackRunning || hasReceivedGeminiChunk || !currentEntity || !currentQuestion) {
      return
    }

    isFallbackRunning = true
    console.log('[Nova UNH WS] Fallback streaming texte demarre.')

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
      const stream = await ai.models.generateContentStream({
        model,
        contents: `${buildGuidePrompt(currentEntity)}

Demande utilisateur:
${currentQuestion}`,
      })

      for await (const chunk of stream) {
        if (chunk.text) {
          sendJson(clientWs, {
            type: 'chunk',
            text: chunk.text,
          })
        }
      }

      sendJson(clientWs, { type: 'turnComplete' })
      console.log('[Nova UNH WS] Fallback streaming texte termine.')
    } catch (error) {
      console.error('[Nova UNH WS] Fallback streaming texte impossible:', error)
      sendJson(clientWs, {
        type: 'error',
        error: 'Gemini Live a ferme sans reponse, et le fallback texte a echoue.',
      })
    }
  }

  function sendLiveText(text) {
    if (!text.trim()) {
      return
    }

    currentQuestion = text

    if (!liveSession || !isGeminiReady) {
      console.log('[Nova UNH WS] Message garde en attente, Gemini Live pas encore pret.')
      pendingMessages.push(text)
      return
    }

    console.log('[Nova UNH WS] Message envoye a Gemini Live.')
    liveSession.sendClientContent({
      turns: [
        {
          role: 'user',
          parts: [{ text }],
        },
      ],
      turnComplete: true,
    })
  }

  async function connectToGemini(entity) {
    currentEntity = entity
    console.log(`[Nova UNH WS] Connexion a Gemini Live pour: ${entity.nom}`)

    if (!process.env.GEMINI_API_KEY) {
      console.log('[Nova UNH WS] Connexion stoppee: GEMINI_API_KEY manquante.')
      sendJson(clientWs, {
        type: 'error',
        error: 'GEMINI_API_KEY manque dans backend/.env.',
      })
      clientWs.close()
      return
    }

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })

      liveSession = await ai.live.connect({
        model: liveModel,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            languageCode: 'fr-FR',
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: 'Puck',
              },
            },
          },
          systemInstruction: buildGuidePrompt(entity),
        },
        callbacks: {
          onopen: () => {
            isGeminiReady = true
            console.log('[Nova UNH WS] Gemini Live connecte.')
            sendJson(clientWs, { type: 'ready' })

            for (const text of pendingMessages.splice(0)) {
              sendLiveText(text)
            }
          },
          onmessage: (message) => {
            const audioParts =
              message.serverContent?.modelTurn?.parts?.filter((part) => part.inlineData?.data) || []

            for (const part of audioParts) {
              hasReceivedGeminiChunk = true
              console.log(
                `[Nova UNH WS] Chunk audio Gemini recu (${part.inlineData.data.length} caracteres base64).`,
              )
              sendJson(clientWs, {
                type: 'audio',
                data: part.inlineData.data,
                mimeType: part.inlineData.mimeType || 'audio/pcm;rate=24000',
              })
            }

            if (message.text) {
              hasReceivedGeminiChunk = true
              console.log(`[Nova UNH WS] Chunk Gemini recu (${message.text.length} caracteres).`)
              sendJson(clientWs, {
                type: 'chunk',
                text: message.text,
              })
            }

            if (message.serverContent?.turnComplete) {
              console.log('[Nova UNH WS] Tour Gemini termine.')
              sendJson(clientWs, { type: 'turnComplete' })
            }
          },
          onerror: (error) => {
            console.error('Erreur Gemini Live:', error)
            sendJson(clientWs, {
              type: 'error',
              error: 'Erreur pendant la session Gemini Live.',
            })
          },
          onclose: (event) => {
            console.log('[Nova UNH WS] Gemini Live ferme.', {
              code: event?.code,
              reason: event?.reason,
              wasClean: event?.wasClean,
              hasReceivedGeminiChunk,
            })

            if (!hasReceivedGeminiChunk) {
              streamTextFallback()
              return
            }

            sendJson(clientWs, { type: 'closed' })
          },
        },
      })
    } catch (error) {
      console.error('Connexion Gemini Live impossible:', error)
      sendJson(clientWs, {
        type: 'error',
        error: 'Impossible de connecter Gemini Live.',
      })
      clientWs.close()
    }
  }

  clientWs.on('message', async (rawMessage) => {
    let payload

    try {
      payload = JSON.parse(rawMessage.toString())
    } catch {
      sendJson(clientWs, {
        type: 'error',
        error: 'Message WebSocket invalide.',
      })
      return
    }

    if (payload.type !== 'audioInput') {
      console.log(`[Nova UNH WS] Message recu du frontend: ${payload.type}`)
    }

    if (payload.type === 'start') {
      console.log(`[Nova UNH WS] Demarrage assistant demande pour: ${payload.entity?.nom || 'entite inconnue'}`)
      if (!validateEntity(payload.entity)) {
        sendJson(clientWs, {
          type: 'error',
          error: "Le nom et la fullDescription de l'entite sont obligatoires.",
        })
        return
      }

      await connectToGemini(payload.entity)
      console.log('[Nova UNH WS] Session assistant prete, attente de la voix utilisateur.')
      return
    }

    if (payload.type === 'message') {
      console.log('[Nova UNH WS] Question utilisateur recue.')
      sendLiveText(payload.text || '')
    }

    if (payload.type === 'audioInput') {
      if (!liveSession || !isGeminiReady) {
        return
      }

      audioInputCount += 1

      if (audioInputCount === 1 || audioInputCount % 50 === 0) {
        console.log(`[Nova UNH WS] Micro recu du frontend (${audioInputCount} chunks).`)
      }

      liveSession.sendRealtimeInput({
        audio: {
          data: payload.data,
          mimeType: payload.mimeType || 'audio/pcm;rate=16000',
        },
      })
    }

    if (payload.type === 'audioEnd') {
      console.log('[Nova UNH WS] Fin du flux micro recue.')
      liveSession?.sendRealtimeInput({
        audioStreamEnd: true,
      })
    }
  })

  clientWs.on('close', () => {
    console.log('[Nova UNH WS] Client frontend deconnecte.')
    liveSession?.close()
  })
})

server.listen(port, () => {
  console.log(`Nova UNH backend pret sur le port ${port}`)
})
