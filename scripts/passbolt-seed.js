#!/usr/bin/env node
/* eslint-env node */

/**
 * Generate a Passbolt test account: an RSA key pair plus the rows to insert.
 *
 *   node scripts/passbolt-seed.js --email admin@passbolt.local --role <role uuid> --out-dir <dir>
 *
 * Run by passbolt-init.sh; not meant to be called by hand. Passbolt 5 only lets
 * you create an account through a browser setup page that requires the browser
 * extension, which is a lot of friction for a throwaway server. This writes the
 * same rows that page would: an active user, a profile and a GPG key. The
 * resulting account authenticates exactly like a real one (the server verifies
 * the JWT challenge against the key in its database), it just never consumed a
 * setup token.
 *
 * Writes <out-dir>/me.asc (private key, 0600) and <out-dir>/seed.sql, and
 * prints { userId, fingerprint, keyId } on stdout.
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { createRequire } = require('module')

function arg (name, fallback) {
  const i = process.argv.indexOf('--' + name)
  if (i === -1 || i + 1 >= process.argv.length) {
    if (fallback !== undefined) return fallback
    throw new Error('missing --' + name)
  }
  return process.argv[i + 1]
}

const WIDGET = path.resolve(__dirname, '..')
let openpgp
try {
  openpgp = createRequire(path.join(WIDGET, 'main.js'))('openpgp')
} catch (e) {
  console.error('')
  console.error('openpgp is missing from node_modules/. Run npm install in the repo root first.')
  process.exit(1)
}

const email = arg('email')
const firstName = arg('first', 'Admin')
const lastName = arg('last', 'User')
const roleId = arg('role')
const outDir = path.resolve(arg('out-dir'))
const passphrase = arg('passphrase', 'passbolt-test')

// MariaDB: a backslash is an escape character by default, and a quote ends the
// string. Armored keys are base64 + header lines, so neither normally appears,
// but escaping both is what keeps a future key format from breaking the script.
function sqlString (value) {
  return "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'"
}

async function main () {
  const { privateKey, publicKey } = await openpgp.generateKey({
    type: 'rsa',
    rsaBits: 4096,
    userIDs: [{ name: `${firstName} ${lastName}`, email }],
    passphrase
  })
  const parsed = await openpgp.readKey({ armoredKey: publicKey })
  // Passbolt stores both uppercase and compares them verbatim when it hands the
  // fingerprint to gpg, so lowercase here fails every login with
  // "The credentials are invalid."
  const fingerprint = parsed.getFingerprint().toUpperCase()
  const keyId = parsed.getKeyID().toHex().toUpperCase()
  const userId = crypto.randomUUID()
  const profileId = crypto.randomUUID()
  const keyRowId = crypto.randomUUID()

  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 })
  const keyPath = path.join(outDir, 'me.asc')
  fs.writeFileSync(keyPath, privateKey, { mode: 0o600 })

  const sql = [
    `INSERT INTO users (id, role_id, username, active, deleted, created, modified)
  VALUES (${sqlString(userId)}, ${sqlString(roleId)}, ${sqlString(email)}, 1, 0, NOW(), NOW());`,
    `INSERT INTO profiles (id, user_id, first_name, last_name, created, modified)
  VALUES (${sqlString(profileId)}, ${sqlString(userId)}, ${sqlString(firstName)}, ${sqlString(lastName)}, NOW(), NOW());`,
    `INSERT INTO gpgkeys (id, user_id, armored_key, bits, uid, key_id, fingerprint, type, expires, key_created, deleted, created, modified)
  VALUES (${sqlString(keyRowId)}, ${sqlString(userId)}, ${sqlString(publicKey)}, 4096, ${sqlString(`${firstName} ${lastName} <${email}>`)}, ${sqlString(keyId)}, ${sqlString(fingerprint)}, 'rsa', NULL, NOW(), 0, NOW(), NOW());`,
    ''
  ].join('\n')
  fs.writeFileSync(path.join(outDir, 'seed.sql'), sql, { mode: 0o600 })

  console.log(JSON.stringify({ userId, fingerprint, keyId, keyPath, sqlPath: path.join(outDir, 'seed.sql') }))
}

main().catch(e => {
  console.error(e.message)
  process.exit(1)
})
