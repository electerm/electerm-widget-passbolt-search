/* eslint-env node */

/**
 * Offline smoke test for the Passbolt widget: a tiny mock Passbolt server that
 * speaks the JWT challenge flow, then the real widget actions.
 *
 *   node scripts/passbolt-mock-and-run.js
 *
 * It generates throwaway keys, serves one Passbolt 5 style (metadata encrypted
 * with the user key) resource and one personal secret, and asserts the widget
 * can connect, search, reveal the password and build an SSH tab. Nothing is
 * sent anywhere but 127.0.0.1. Run it from the repo root; dependencies are vendored.
 */

const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert')
const { createRequire } = require('module')

const WIDGET = path.resolve(__dirname, '..')
const widgetRequire = createRequire(path.join(WIDGET, 'main.js'))
const openpgp = widgetRequire('openpgp')
const widget = require(path.join(WIDGET, 'main.js'))

const USER_ID = '11111111-1111-4111-8111-111111111111'
const PASSPHRASE = 'pw-123'

function readJson (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

async function main () {
  const serverKeys = await openpgp.generateKey({
    type: 'rsa',
    rsaBits: 2048,
    userIDs: [{ name: 'Mock Passbolt', email: 'server@example.com' }]
  })
  const userKeys = await openpgp.generateKey({
    type: 'rsa',
    rsaBits: 2048,
    userIDs: [{ name: 'Test User', email: 'user@example.com' }],
    passphrase: PASSPHRASE
  })
  const serverPrivate = await openpgp.readPrivateKey({ armoredKey: serverKeys.privateKey })
  const serverPublic = await openpgp.readKey({ armoredKey: serverKeys.publicKey })
  const userPublic = await openpgp.readKey({ armoredKey: userKeys.publicKey })
  const userPrivate = await openpgp.decryptKey({
    privateKey: await openpgp.readPrivateKey({ armoredKey: userKeys.privateKey }),
    passphrase: PASSPHRASE
  })

  const keyFile = path.join(os.tmpdir(), `mock-passbolt-${process.pid}.key`)
  fs.writeFileSync(keyFile, userKeys.privateKey, { mode: 0o600 })

  // The widget remembers the last server it trusted, and this mock mints a new
  // server key on every run. Hide that state for the duration so a previous run
  // against a real instance does not look like a fingerprint change (which is
  // exactly the guard it should raise), then put it back.
  const statePath = path.join(WIDGET, '.state.json')
  const savedState = fs.existsSync(statePath) ? fs.readFileSync(statePath) : null
  fs.rmSync(statePath, { force: true })

  // Passbolt 5 nests the fields under data (v4 kept them flat)
  const secretPayload = JSON.stringify({
    object_type: 'PASSBOLT_SECRET_DATA',
    data: {
      password: 's3cret',
      username: 'root'
    }
  })

  // Passbolt 5.x encrypts the resource metadata itself; the list endpoint then
  // carries no plaintext name/username/uri at all.
  const metadataArmored = await openpgp.encrypt({
    message: await openpgp.createMessage({
      text: JSON.stringify({
        object_type: 'PASSBOLT_RESOURCE_METADATA',
        resource_type_id: 'rt-1',
        name: 'Router',
        username: 'root',
        uris: ['ssh://root@10.0.0.12:2222'],
        description: 'edge router',
        custom_fields: {}
      })
    }),
    encryptionKeys: userPublic,
    signingKeys: userPrivate
  })

  const httpServer = http.createServer(async (req, res) => {
    const send = (body, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (url.pathname === '/auth/verify.json') {
        return send({
          header: { message: 'OK' },
          body: {
            keydata: serverKeys.publicKey,
            fingerprint: serverPublic.getFingerprint().toUpperCase()
          }
        })
      }
      if (url.pathname === '/auth/jwt/login.json' && req.method === 'POST') {
        const body = await readJson(req)
        const message = await openpgp.readMessage({ armoredMessage: body.challenge })
        const { data } = await openpgp.decrypt({
          message,
          decryptionKeys: serverPrivate,
          verificationKeys: userPublic
        })
        const challenge = JSON.parse(data)
        const token = {
          version: challenge.version,
          domain: challenge.domain,
          verify_token: challenge.verify_token,
          access_token: 'mock-access-token',
          refresh_token: 'mock-refresh-token'
        }
        const armored = await openpgp.encrypt({
          message: await openpgp.createMessage({ text: JSON.stringify(token) }),
          encryptionKeys: userPublic,
          signingKeys: serverPrivate
        })
        return send({ header: { message: 'OK' }, body: { challenge: armored } })
      }
      if (url.pathname === '/users/me.json') {
        return send({ header: { message: 'OK' }, body: { id: USER_ID, username: 'user@example.com' } })
      }
      if (url.pathname === '/resources.json') {
        return send({
          header: { message: 'OK', pagination: { limit: 2000, count: 1 } },
          body: [{
            id: 'res-1',
            metadata: metadataArmored,
            metadata_key_type: 'user_key',
            resource_type_id: 'rt-1',
            resource_type: { name: 'password' },
            modified_by: USER_ID,
            created_by: USER_ID
          }]
        })
      }
      if (url.pathname === '/secrets/resource/res-1.json') {
        const data = await openpgp.encrypt({
          message: await openpgp.createMessage({ text: secretPayload }),
          encryptionKeys: userPublic,
          signingKeys: userPrivate
        })
        return send({
          header: { message: 'OK' },
          body: {
            id: 'secret-1',
            user_id: USER_ID,
            resource_id: 'res-1',
            data,
            modified_by: USER_ID
          }
        })
      }
      if (url.pathname === '/auth/jwt/logout.json') {
        return send({ header: { message: 'OK' }, body: {} })
      }
      send({ header: { message: `not found: ${url.pathname}` } }, 404)
    } catch (e) {
      send({ header: { message: `mock error: ${e.message}` } }, 500)
    }
  })

  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${httpServer.address().port}`
  const config = {
    serverUrl: baseUrl,
    userId: USER_ID,
    keyPath: keyFile,
    passphrase: PASSPHRASE
  }

  try {
    const first = await widget.run({ ...config, query: '' })
    assert.equal(first.messageType, 'warning')
    assert.match(first.details[0].value, /^[0-9A-F ]+$/)
    assert.equal(first.buttons[0].action, 'trust')

    const connected = await widget.trust({ ...config, query: '' })
    assert.match(connected.message, /^Connected to /)

    const found = await widget.run({ ...config, query: '10.0.0.12' })
    assert.equal(found.table.rows.length, 1)
    assert.equal(found.table.rows[0].name, 'Router')

    const row = found.table.rows[0]
    const detail = await widget.details(row)
    assert.equal(detail.details.find(item => item.label === 'Password').value, 's3cret')
    assert.equal(detail.details.find(item => item.label === 'Username').value, 'root')

    const opened = await widget.openSsh(row)
    assert.equal(opened.openTab.host, '10.0.0.12')
    assert.equal(opened.openTab.port, 2222)
    assert.equal(opened.openTab.username, 'root')
    assert.equal(opened.openTab.password, 's3cret')

    await widget.lock()
    console.log('PASS: connect -> trust -> search -> details -> openSsh -> lock')
  } finally {
    await new Promise(resolve => httpServer.close(resolve))
    fs.rmSync(keyFile, { force: true })
    fs.rmSync(statePath, { force: true })
    if (savedState) {
      fs.writeFileSync(statePath, savedState, { mode: 0o600 })
    }
  }
}

main().catch(err => {
  console.error('FAIL:', err)
  process.exit(1)
})
