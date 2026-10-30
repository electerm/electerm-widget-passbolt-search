#!/usr/bin/env node
/* eslint-env node */

/**
 * Generate sample entries for the local Passbolt test server.
 *
 *   node scripts/passbolt-samples.js --user-id <uuid> --gpgkey-id <uuid> \
 *     --key scripts/.passbolt/me.asc --passphrase passbolt-test --out /tmp/samples.sql
 *
 * Run by passbolt-init.sh (--samples); not meant to be called by hand. It emits
 * SQL that inserts one entry of every resource type Passbolt 5 ships: the three
 * legacy (v4, plaintext metadata) types and three v5 types, so the widget can
 * be exercised against both metadata paths and both secret shapes.
 *
 * Every row is encrypted to the account's own public key and signed by it, and
 * every entry is personal (a single owner permission), which is what the server
 * checks when it serves the secret back.
 *
 * All ids are fixed, so the SQL starts by deleting whatever an earlier run left
 * behind: running it again resets the sample set instead of duplicating it.
 */

const fs = require('fs')
const path = require('path')
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
  console.error('openpgp is missing from node_modules/. Run npm install in the repo root first.')
  process.exit(1)
}

const userId = arg('user-id')
const gpgkeyId = arg('gpgkey-id')
const keyPath = path.resolve(arg('key'))
const passphrase = arg('passphrase', 'passbolt-test')
const outPath = path.resolve(arg('out'))

// Resource type ids are fixed in Passbolt's schema (same uuid in every install),
// the legacy slugs are the ones the v4 API still serves in plaintext.
const TYPES = {
  'password-string': '669f8c64-242a-59fb-92fc-81f660975fd3',
  'password-and-description': 'a28a04cd-6f53-518a-967c-9963bf9cec51',
  'password-description-totp': '8cca88d9-a3f6-56df-b860-3ef08de5c5c4',
  'v5-default': 'dd1f723d-0d1e-513f-8218-4055dc0530d0',
  'v5-default-with-totp': '7438294d-f71c-5164-ba95-d9e60e295564',
  'v5-note': '0a72c76b-b8e6-53f0-8bef-0a8ca6b5c764'
}

// A fixed id per sample keeps the script idempotent (delete, then insert).
function sampleId (n) {
  return `0f5a3c1e-0000-4000-8000-${String(n).padStart(12, '0')}`
}

const TOTP = {
  secret_key: 'JBSWY3DPEHPK3PXP',
  period: 30,
  digits: 6,
  algorithm: 'SHA1'
}

/**
 * One entry per shape:
 * - password-string     no username, no uri (checks the empty-column path)
 * - password-and-desc   https, username, description
 * - password-and-desc   ssh with a port (the widget's SSH button reads it)
 * - password-and-desc   ftp with a port
 * - ...-totp            v4 totp, stored as a JSON *string* inside the secret
 * - v5-default          encrypted metadata, secret { object_type, data }
 * - v5-default-with-totp  v5 totp, stored as a nested object
 * - v5-note             a note: metadata + description only
 */
const SAMPLES = [
  {
    n: 1,
    type: 'password-string',
    name: 'Jenkins API token',
    password: 'J3nkins-t0ken-9f2c'
  },
  {
    n: 2,
    type: 'password-and-description',
    name: 'Example website',
    username: 'demo@example.com',
    uri: 'https://example.com/login',
    description: 'Shared demo account, rotate every quarter.',
    password: 'Ex4mple-w3bsite!'
  },
  {
    n: 3,
    type: 'password-and-description',
    name: 'Router SSH',
    username: 'root',
    uri: 'ssh://root@10.0.0.12:2222',
    description: 'Edge router, non-standard port.',
    password: 'R0uter-ssh-2222'
  },
  {
    n: 4,
    type: 'password-and-description',
    name: 'Deploy FTP',
    username: 'deploy',
    uri: 'ftp://deploy@files.example.com:2121',
    description: 'Release upload account.',
    password: 'F7p-deploy-pass'
  },
  {
    n: 5,
    type: 'password-description-totp',
    name: 'VPN gateway',
    username: 'vpnuser',
    uri: 'https://vpn.example.com',
    description: 'TOTP enabled (v4 shape: totp is a JSON string).',
    password: 'Vpn-g4teway-pass',
    totp: JSON.stringify(TOTP)
  },
  {
    n: 6,
    type: 'v5-default',
    name: 'v5 default entry',
    username: 'v5user',
    uri: 'https://v5.example.org',
    description: 'Passbolt 5 format: metadata and secret are both nested.',
    password: 'V5-default-pass!'
  },
  {
    n: 7,
    type: 'v5-default-with-totp',
    name: 'v5 with TOTP',
    username: 'totpuser',
    uri: 'https://totp.example.org',
    description: 'TOTP enabled (v5 shape: totp is an object).',
    password: 'V5-totp-pass!',
    totp: TOTP
  },
  {
    n: 8,
    type: 'v5-note',
    name: 'v5 note',
    description: 'A standalone note: no password, no username, no uri.',
    note: 'Door code for the office lab is on the back of the badge reader.'
  }
]

function sqlString (value) {
  if (value === null || value === undefined || value === '') return 'NULL'
  // MariaDB: backslash escapes and quotes end strings, so escape both.
  return "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'"
}

async function main () {
  const armored = fs.readFileSync(keyPath, 'utf8')
  const privateKey = await openpgp.decryptKey({
    privateKey: await openpgp.readPrivateKey({ armoredKey: armored }),
    passphrase
  })
  const publicKey = privateKey.toPublic()

  async function seal (payload) {
    return openpgp.encrypt({
      message: await openpgp.createMessage({ text: JSON.stringify(payload) }),
      encryptionKeys: publicKey,
      signingKeys: privateKey
    })
  }

  const rows = []
  for (const sample of SAMPLES) {
    const id = sampleId(sample.n)
    const isV5 = sample.type.startsWith('v5-')
    const resourceTypeId = TYPES[sample.type]
    if (!resourceTypeId) throw new Error(`unknown type ${sample.type}`)

    // Legacy types carry their metadata in plain columns; v5 types carry an
    // encrypted blob instead and leave those columns empty.
    const metadata = isV5
      ? await seal({
        object_type: 'PASSBOLT_RESOURCE_METADATA',
        resource_type_id: resourceTypeId,
        name: sample.name,
        username: sample.username || '',
        uris: sample.uri ? [sample.uri] : [],
        description: sample.description || '',
        custom_fields: {}
      })
      : null

    let secretPayload
    if (sample.type === 'v5-note') {
      secretPayload = {
        object_type: 'PASSBOLT_SECRET_DATA',
        data: { description: sample.note }
      }
    } else if (isV5) {
      secretPayload = {
        object_type: 'PASSBOLT_SECRET_DATA',
        data: {
          password: sample.password,
          description: sample.description || '',
          ...(sample.totp ? { totp: sample.totp } : {})
        }
      }
    } else {
      secretPayload = {
        password: sample.password,
        ...(sample.description ? { description: sample.description } : {}),
        ...(sample.totp ? { totp: sample.totp } : {})
      }
    }
    const secret = await seal(secretPayload)

    rows.push({
      id,
      revisionId: `0f5a3c1e-1111-4000-8000-${String(sample.n).padStart(12, '0')}`,
      secretId: `0f5a3c1e-2222-4000-8000-${String(sample.n).padStart(12, '0')}`,
      permissionId: `0f5a3c1e-3333-4000-8000-${String(sample.n).padStart(12, '0')}`,
      resourceTypeId,
      // user_key: the resource is encrypted with the owner's own key, which is
      // what a personal entry on a stock CE install gets (metadata_key_id then
      // points at that user's gpgkeys row, not at metadata_keys).
      metadataKeyId: isV5 ? gpgkeyId : null,
      metadata,
      name: sample.name,
      username: sample.username || null,
      uri: sample.uri || null,
      description: sample.description || null,
      secret
    })
  }

  const ids = rows.map(row => sqlString(row.id)).join(', ')
  const sql = [
    '-- sample entries for the passbolt-search widget (generated)',
    `DELETE FROM permissions WHERE aco='Resource' AND aco_foreign_key IN (${ids});`,
    `DELETE FROM secrets WHERE resource_id IN (${ids});`,
    `DELETE FROM secret_revisions WHERE resource_id IN (${ids});`,
    `DELETE FROM resources WHERE id IN (${ids});`,
    ''
  ]

  for (const row of rows) {
    sql.push(
      `INSERT INTO resources (id, name, username, uri, description, metadata, metadata_key_id, metadata_key_type, deleted, created, modified, created_by, modified_by, resource_type_id)
  VALUES (${sqlString(row.id)}, ${sqlString(row.name)}, ${sqlString(row.username)}, ${sqlString(row.uri)}, ${sqlString(row.description)}, ${sqlString(row.metadata)}, ${sqlString(row.metadataKeyId)}, ${sqlString(row.metadata ? 'user_key' : null)}, 0, NOW(), NOW(), ${sqlString(userId)}, ${sqlString(userId)}, ${sqlString(row.resourceTypeId)});`,
      `INSERT INTO secret_revisions (id, resource_id, resource_type_id, deleted, created, modified, created_by, modified_by)
  VALUES (${sqlString(row.revisionId)}, ${sqlString(row.id)}, ${sqlString(row.resourceTypeId)}, NULL, NOW(), NOW(), ${sqlString(userId)}, ${sqlString(userId)});`,
      `INSERT INTO secrets (id, user_id, resource_id, secret_revision_id, deleted, created_by, modified_by, data, created, modified)
  VALUES (${sqlString(row.secretId)}, ${sqlString(userId)}, ${sqlString(row.id)}, ${sqlString(row.revisionId)}, NULL, ${sqlString(userId)}, ${sqlString(userId)}, ${sqlString(row.secret)}, NOW(), NOW());`,
      `INSERT INTO permissions (id, aco, aco_foreign_key, aro, aro_foreign_key, type, created, modified)
  VALUES (${sqlString(row.permissionId)}, 'Resource', ${sqlString(row.id)}, 'User', ${sqlString(userId)}, 15, NOW(), NOW());`,
      ''
    )
  }

  // The API reads these with the app's own timezone offsets; nothing to do here.
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, sql.join('\n'), { mode: 0o600 })
  console.log(JSON.stringify({
    count: rows.length,
    sqlPath: outPath,
    names: rows.map(row => row.name)
  }))
}

main().catch(e => {
  console.error(e.message)
  process.exit(1)
})
