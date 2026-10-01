// Drives src/octoprint.js against a stub OctoPrint: the multipart body, the key header, the error messages,
// and the mixed-content check. Run with `node test_upload.mjs`.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { checkConnection, connectionProblem, isPrintable, uploadGcode } from './src/octoprint.js'

const KEY = 'test-key'
const received = []
const server = createServer((request, response) => {
  if (request.headers['x-api-key'] !== KEY) {
    response.writeHead(403).end('Invalid API key')
    return
  }
  if (request.method === 'GET' && request.url === '/octoprint/api/version') {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ api: '0.1', server: '1.10.2' }))
    return
  }
  if (request.method === 'POST' && request.url === '/octoprint/api/files/local') {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      received.push({ type: request.headers['content-type'], body: Buffer.concat(chunks).toString() })
      response.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ done: true }))
    })
    return
  }
  response.writeHead(404).end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/octoprint`   // a sub-path, as behind a reverse proxy

try {
  // --- which exports go to OctoPrint
  assert.equal(isPrintable('plate_1.gcode'), true)
  assert.equal(isPrintable('plate_1.gcode.3mf'), false)
  assert.equal(isPrintable('model.stl'), false)

  // --- mixed content is caught before a request is made
  assert.match(connectionProblem('http://octopi.local', 'https:'), /mixed content/)
  assert.equal(connectionProblem('http://octopi.local', 'http:'), null)
  assert.equal(connectionProblem('https://octopi.example', 'https:'), null)
  assert.equal(connectionProblem('http://localhost:5000', 'https:'), null)
  assert.match(connectionProblem('octopi.local', 'http:'), /Enter the OctoPrint address/)
  assert.match(connectionProblem('ftp://octopi.local', 'http:'), /http:\/\//)

  // --- connection check
  assert.equal(await checkConnection({ url, apiKey: KEY }), '1.10.2')
  await assert.rejects(checkConnection({ url, apiKey: 'wrong' }), /rejected the API key \(403\)/)
  await assert.rejects(checkConnection({ url: 'http://127.0.0.1:1', apiKey: KEY }), /Could not reach OctoPrint.*CORS/)

  // --- upload: multipart file + select/print fields, with or without starting the print
  const gcode = ';TYPE:External perimeter\nG1 X10 Y10 E1\n'
  assert.deepEqual(await uploadGcode({ url: `${url}/`, apiKey: KEY, file: new Blob([gcode]), filename: 'plate_1.gcode', print: true }), { done: true })
  assert.match(received[0].type, /^multipart\/form-data; boundary=/)
  assert.match(received[0].body, /name="file"; filename="plate_1.gcode"/)
  assert.ok(received[0].body.includes(gcode), 'the G-code text reaches the server unchanged')
  assert.match(received[0].body, /name="print"\r\n\r\ntrue/)
  assert.match(received[0].body, /name="select"\r\n\r\ntrue/)

  await uploadGcode({ url, apiKey: KEY, file: new Blob([gcode]), filename: 'plate_2.gcode' })
  assert.match(received[1].body, /name="print"\r\n\r\nfalse/)

  await assert.rejects(uploadGcode({ url, apiKey: 'wrong', file: new Blob([gcode]), filename: 'x.gcode' }), /rejected the API key/)
  console.log('octoprint upload: ok')
} finally {
  server.close()
}
