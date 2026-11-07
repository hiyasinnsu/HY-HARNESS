import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { hostAllowed, htmlToText, webFetch } from './web.js'

test('htmlToText keeps readable text and decodes entities', () => {
  const r = htmlToText(
    '<html><head><title> Docs &amp; more </title><style>p{}</style></head><body><script>x()</script>' +
      '<h1>Title</h1><p>One &lt;two&gt; &#x41;&#66;</p><ul><li>a</li><li>b</li></ul><!-- hidden --></body></html>',
  )
  assert.equal(r.title, 'Docs & more')
  assert.equal(r.text, 'Title\nOne <two> AB\n\n- a\n- b')
})

test('hostAllowed matches a domain and its subdomains only', () => {
  const allow = ['example.com', '*.docs.rs']
  assert.ok(hostAllowed(new URL('https://example.com/x'), allow))
  assert.ok(hostAllowed(new URL('https://api.example.com/x'), allow))
  assert.ok(hostAllowed(new URL('https://crates.docs.rs/'), allow))
  assert.ok(!hostAllowed(new URL('https://example.com.evil.net/'), allow))
  assert.ok(!hostAllowed(new URL('https://notexample.com/'), allow))
})

test('webFetch converts HTML, caps the size and refuses other schemes', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('x'.repeat(5_000))
    } else {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<title>T</title><p>hello</p>')
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const page = await webFetch(`${base}/`)
    assert.equal(page.status, 200)
    assert.equal(page.title, 'T')
    assert.equal(page.text, 'hello')
    assert.equal(page.truncated, false)
    const big = await webFetch(`${base}/big`, { maxBytes: 1_000 })
    assert.equal(big.text.length, 1_000)
    assert.equal(big.truncated, true)
    await assert.rejects(webFetch('file:///C:/Windows/win.ini'), /only http and https/)
    await assert.rejects(webFetch('not a url'), /invalid URL/)
  } finally {
    server.close()
  }
})

test('webFetch checks every redirect target before it connects', async () => {
  let reachedTarget = 0
  const target = http.createServer((_req, res) => {
    reachedTarget++
    res.writeHead(200, { 'content-type': 'text/plain' }).end('internal secret')
  })
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r))
  const targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}/secret`
  const allowed = http.createServer((req, res) => {
    if (req.url === '/hop') return void res.writeHead(302, { location: '/end' }).end()
    if (req.url === '/end') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('same host')
    res.writeHead(302, { location: targetUrl }).end()
  })
  await new Promise<void>((r) => allowed.listen(0, '127.0.0.1', r))
  const base = `http://localhost:${(allowed.address() as AddressInfo).port}`
  try {
    const seen: string[] = []
    await assert.rejects(
      webFetch(`${base}/`, {}, async (next) => {
        seen.push(next.href)
        throw new Error(`web_fetch not approved: ${next.href}`)
      }),
      /not approved/,
    )
    assert.deepEqual(seen, [targetUrl])
    assert.equal(reachedTarget, 0, 'the unapproved host was never contacted')
    // An approved redirect is followed, and the final URL is reported.
    const page = await webFetch(`${base}/hop`, {}, async () => undefined)
    assert.equal(page.text, 'same host')
    assert.equal(page.url, `${base}/end`)
  } finally {
    allowed.close()
    target.close()
  }
})

test('webSearch reads a SearXNG-style JSON endpoint', async () => {
  const { webSearch } = await import('./web.js')
  let seen = ''
  const server = http.createServer((req, res) => {
    seen = req.url ?? ''
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ results: [{ url: 'https://a.example/', title: ' A ', content: 'first   hit' }, { title: 'no url' }, { url: 'https://b.example/' }] }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const searchUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/search`
  try {
    const r = await webSearch('rust borrow checker', { searchUrl })
    assert.equal(seen, '/search?q=rust+borrow+checker&format=json')
    assert.deepEqual(r.results, [
      { url: 'https://a.example/', title: 'A', snippet: 'first hit' },
      { url: 'https://b.example/', title: '', snippet: '' },
    ])
    assert.equal((await webSearch('x', { searchUrl }, 1)).results.length, 1)
    await assert.rejects(webSearch('x', {}), /needs web.searchUrl/)
  } finally {
    server.close()
  }
})
