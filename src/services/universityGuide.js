function logGuide(message, detail, callbacks) {
  console.log(`[Nova UNH WS] ${message}`, detail || '')
  callbacks?.onLog?.(message, detail)
}

function getSampleRate(mimeType = '') {
  const match = mimeType.match(/rate=(\d+)/)
  return match ? Number(match[1]) : 24000
}

function base64ToArrayBuffer(base64) {
  const binary = window.atob(base64)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes.buffer
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''

  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index])
  }

  return window.btoa(binary)
}

function floatTo16BitPcm(samples) {
  const buffer = new ArrayBuffer(samples.length * 2)
  const view = new DataView(buffer)

  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]))
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }

  return buffer
}

function downsample(buffer, inputRate, outputRate) {
  if (outputRate === inputRate) {
    return buffer
  }

  const ratio = inputRate / outputRate
  const newLength = Math.round(buffer.length / ratio)
  const result = new Float32Array(newLength)

  for (let index = 0; index < newLength; index += 1) {
    const start = Math.floor(index * ratio)
    const end = Math.floor((index + 1) * ratio)
    let sum = 0
    let count = 0

    for (let inputIndex = start; inputIndex < end && inputIndex < buffer.length; inputIndex += 1) {
      sum += buffer[inputIndex]
      count += 1
    }

    result[index] = count ? sum / count : 0
  }

  return result
}

function createAudioQueue() {
  const AudioContext = window.AudioContext || window.webkitAudioContext
  const context = new AudioContext()
  const gain = context.createGain()
  let nextStartTime = context.currentTime
  let chain = Promise.resolve()

  gain.gain.value = 1.35
  gain.connect(context.destination)

  async function unlock(callbacks) {
    if (context.state === 'suspended') {
      await context.resume()
    }

    const silentBuffer = context.createBuffer(1, 1, context.sampleRate)
    const source = context.createBufferSource()
    source.buffer = silentBuffer
    source.connect(gain)
    source.start()

    logGuide('AudioContext pret.', { state: context.state, sampleRate: context.sampleRate }, callbacks)
  }

  async function playBase64AudioNow(data, mimeType, callbacks) {
    if (context.state === 'suspended') {
      await context.resume()
    }

    const arrayBuffer = base64ToArrayBuffer(data)

    if (mimeType?.includes('wav') || mimeType?.includes('mpeg') || mimeType?.includes('mp3')) {
      const decoded = await context.decodeAudioData(arrayBuffer.slice(0))
      const source = context.createBufferSource()
      source.buffer = decoded
      source.connect(gain)
      source.start(Math.max(context.currentTime, nextStartTime))
      nextStartTime = Math.max(context.currentTime, nextStartTime) + decoded.duration
      logGuide('Chunk audio decode joue.', { mimeType, duration: decoded.duration }, callbacks)
      return
    }

    const view = new DataView(arrayBuffer)
    const sampleCount = Math.floor(view.byteLength / 2)
    const audioBuffer = context.createBuffer(1, sampleCount, getSampleRate(mimeType))
    const channel = audioBuffer.getChannelData(0)

    for (let index = 0; index < sampleCount; index += 1) {
      channel[index] = view.getInt16(index * 2, true) / 32768
    }

    const source = context.createBufferSource()
    source.buffer = audioBuffer
    source.connect(gain)
    source.start(Math.max(context.currentTime, nextStartTime))
    nextStartTime = Math.max(context.currentTime, nextStartTime) + audioBuffer.duration
  }

  function playBase64Audio(data, mimeType, callbacks) {
    chain = chain.then(() => playBase64AudioNow(data, mimeType, callbacks))
    return chain
  }

  return { context, playBase64Audio, unlock }
}

async function createMicrophoneStreamer(socket, audioContext, callbacks) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  })
  const source = audioContext.createMediaStreamSource(stream)
  const processor = audioContext.createScriptProcessor(4096, 1, 1)
  const silentOutput = audioContext.createGain()
  let chunkCount = 0

  silentOutput.gain.value = 0
  source.connect(processor)
  processor.connect(silentOutput)
  silentOutput.connect(audioContext.destination)

  processor.onaudioprocess = (event) => {
    if (socket.readyState !== WebSocket.OPEN) {
      return
    }

    const input = event.inputBuffer.getChannelData(0)
    const downsampled = downsample(input, audioContext.sampleRate, 16000)
    const pcmBuffer = floatTo16BitPcm(downsampled)

    socket.send(
      JSON.stringify({
        type: 'audioInput',
        mimeType: 'audio/pcm;rate=16000',
        data: arrayBufferToBase64(pcmBuffer),
      }),
    )

    chunkCount += 1

    if (chunkCount === 1 || chunkCount % 50 === 0) {
      logGuide('Micro envoye au backend.', { chunkCount }, callbacks)
    }
  }

  logGuide(
    'Micro active.',
    {
      tracks: stream.getAudioTracks().map((track) => track.label),
      sampleRate: audioContext.sampleRate,
    },
    callbacks,
  )

  return {
    stop() {
      processor.disconnect()
      silentOutput.disconnect()
      source.disconnect()
      stream.getTracks().forEach((track) => track.stop())

      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'audioEnd' }))
      }

      logGuide('Micro stoppe.', { chunkCount }, callbacks)
    },
  }
}

function speakFallback(text) {
  if (!text.trim() || !window.speechSynthesis) {
    return
  }

  window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = 'fr-FR'
  utterance.rate = 0.96
  window.speechSynthesis.speak(utterance)
}

function getBackendWsUrl() {
  const configuredBackendUrl = import.meta.env.VITE_BACKEND_URL

  if (configuredBackendUrl) {
    const url = new URL(configuredBackendUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = '/guide-live'
    url.search = ''
    url.hash = ''
    return url.toString()
  }

  if (!import.meta.env.DEV) {
    return null
  }

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const host = window.location.hostname || '127.0.0.1'
  return `${protocol}://${host}:3001/guide-live`
}

export async function startUniversityGuide(entity, callbacks = {}) {
  const wsUrl = getBackendWsUrl()

  if (!wsUrl) {
    callbacks.onStatus?.('error')
    alert("L'URL du backend n'est pas configuree. Ajoute VITE_BACKEND_URL dans Netlify puis redeploie le site.")

    return {
      stop() {
        callbacks.onStatus?.('idle')
        callbacks.onClose?.()
      },
    }
  }

  const socket = new WebSocket(wsUrl)
  const audioQueue = createAudioQueue()
  let microphone = null
  let guideResponse = ''
  let hasAudio = false
  let isStopped = false

  logGuide('Connexion au backend...', { wsUrl, entity: entity.nom }, callbacks)
  await audioQueue.unlock(callbacks)

  socket.addEventListener('open', async () => {
    callbacks.onStatus?.('listening')
    logGuide('WebSocket backend connecte.', { readyState: socket.readyState }, callbacks)

    socket.send(
      JSON.stringify({
        type: 'start',
        entity: {
          nom: entity.nom,
          type: entity.type,
          description: entity.description,
          fullDescription: entity.fullDescription,
        },
      }),
    )

    try {
      microphone = await createMicrophoneStreamer(socket, audioQueue.context, callbacks)
      callbacks.onStatus?.('listening')
    } catch (error) {
      callbacks.onStatus?.('error')
      logGuide('Permission micro refusee ou indisponible.', error, callbacks)
      alert("Le micro n'est pas accessible. Autorise le micro dans le navigateur.")
    }

    logGuide("Contexte de l'entite envoye au backend.", { entity: entity.nom }, callbacks)
  })

  socket.addEventListener('message', async (event) => {
    let data

    try {
      data = JSON.parse(event.data)
    } catch {
      callbacks.onStatus?.('error')
      logGuide('Reponse backend invalide.', event.data, callbacks)
      alert('Le backend a envoye une reponse invalide.')
      socket.close()
      return
    }

    logGuide(`Message recu: ${data.type}`, data.type === 'audio' ? data.mimeType : data, callbacks)

    if (data.type === 'ready') {
      callbacks.onStatus?.('listening')
    }

    if (data.type === 'audio') {
      hasAudio = true
      callbacks.onStatus?.('speaking')
      await audioQueue.playBase64Audio(data.data, data.mimeType, callbacks)
    }

    if (data.type === 'chunk') {
      callbacks.onStatus?.('answering')
      guideResponse += data.text
      callbacks.onChunk?.(data.text)
    }

    if (data.type === 'turnComplete') {
      if (!hasAudio && guideResponse) {
        speakFallback(guideResponse)
      }

      callbacks.onStatus?.('listening')
      guideResponse = ''
      hasAudio = false
    }

    if (data.type === 'closed') {
      callbacks.onStatus?.('idle')
    }

    if (data.type === 'error') {
      callbacks.onStatus?.('error')
      alert(data.error)
      socket.close()
    }
  })

  socket.addEventListener('close', (event) => {
    microphone?.stop()
    microphone = null
    callbacks.onStatus?.('idle')
    callbacks.onClose?.()
    logGuide('WebSocket ferme.', { code: event.code, reason: event.reason }, callbacks)
  })

  socket.addEventListener('error', () => {
    callbacks.onStatus?.('error')
    logGuide('Erreur WebSocket.', { readyState: socket.readyState }, callbacks)
    alert("L'assistant n'est pas disponible. Verifie que le backend est lance et que la cle API est dans backend/.env.")
  })

  return {
    stop() {
      if (isStopped) {
        return
      }

      isStopped = true
      microphone?.stop()
      microphone = null
      window.speechSynthesis?.cancel()

      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close()
      }

      callbacks.onStatus?.('idle')
      callbacks.onClose?.()
      logGuide('Session assistant arretee par utilisateur.', null, callbacks)
    },
  }
}
