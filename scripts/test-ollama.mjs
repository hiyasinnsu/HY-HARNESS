const body = {
  model: 'qwen3:4b',
  stream: false,
  think: false,
  format: 'json',
  messages: [
    {
      role: 'system',
      content:
        'You are a coding agent. Reply with exactly one JSON object. ' +
        'To use a tool reply {"tool":"read_file","args":{"path":"README.md"}}. ' +
        'To finish reply {"final":"done"}.',
    },
    { role: 'user', content: 'Read README.md using the tool.' },
  ],
  options: { temperature: 0, num_predict: 200 },
}
const r = await fetch('http://127.0.0.1:11434/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
console.log(r.status)
console.log((await r.text()).slice(0, 2000))
