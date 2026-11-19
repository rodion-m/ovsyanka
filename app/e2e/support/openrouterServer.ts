import { createServer, type Server } from 'node:http'

const audioModel = {
  id: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash', created: 1_800_000_000,
  architecture: { input_modalities: ['text', 'audio'], output_modalities: ['text'] },
  endpoints: ['/api/v1/chat/completions'], pricing: { prompt: '0.000000825', completion: '0.000004125', audio: '0.000000825' },
  context_length: 1_000_000, supported_parameters: ['structured_outputs', 'reasoning', 'temperature'],
  top_provider: { max_completion_tokens: 65536 }, reasoning: { supported_efforts: ['low', 'medium', 'high'] },
}
const textModel = { ...audioModel, id: 'acme/test-text', name: 'Fake text model', architecture: { input_modalities: ['text'], output_modalities: ['text'] } }
const sttModel = { ...audioModel, id: 'acme/test-stt', name: 'Fake STT', architecture: { input_modalities: ['audio'], output_modalities: ['transcription'] }, endpoints: ['/api/v1/audio/transcriptions'] }

export async function startOpenRouterServer() {
  let credits = false
  let calls = 0
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString('utf8')
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    response.setHeader('content-type', 'application/json')
    if (path === '/api/v1/key') {
      response.writeHead(200).end(JSON.stringify({ data: { label: 'Yogurt e2e', limit_remaining: 4.2 } }))
      return
    }
    if (path === '/api/v1/models') {
      const stt = request.url?.includes('output_modalities=transcription')
      response.writeHead(200).end(JSON.stringify({ data: stt ? [sttModel] : [audioModel, textModel] }))
      return
    }
    if (path === '/api/v1/chat/completions') {
      calls++
      if (credits) {
        response.writeHead(402).end(JSON.stringify({ error: { message: 'Insufficient credits', code: 'insufficient_credits' } }))
        return
      }
      const parsed = JSON.parse(body) as { messages?: Array<{ content?: unknown }> }
      const audio = JSON.stringify(parsed.messages ?? []).includes('input_audio')
      const content = audio ? JSON.stringify({ language: 'ru', error: '', segments: [{ start: 0, end: 1, text: 'Здравствуйте, проверка связи.' }] }) : 'OK'
      response.writeHead(200).end(JSON.stringify({ id: `e2e-${calls}`, model: audioModel.id, choices: [{ message: { content } }], usage: { cost: 0.0001 } }))
      return
    }
    response.writeHead(404).end(JSON.stringify({ error: { message: 'unknown route' } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not start fake OpenRouter server')
  return {
    url: `http://127.0.0.1:${address.port}/api/v1`,
    setCredits: (value: boolean) => { credits = value },
    calls: () => calls,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}
