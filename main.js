/**
 * Passbolt Search — an electerm config-mode widget.
 *
 * Based on code by GitHub user @palsanyi (https://github.com/palsanyi).
 *
 * There is no UI in this folder: electerm renders the form from
 * `electerm.configs` in package.json, calls `run(config)` on submit, and draws
 * the object `run` returns (message/details/table/buttons/openTab). Row buttons
 * in the result call the other exported functions with `(row, config)`.
 *
 * Security model (same as the original handoff):
 * - the private key file and its passphrase never leave this machine; the key
 *   is read here, in the main process, and the passphrase is not persisted;
 * - decrypted metadata and secrets stay in this module's memory;
 * - the Passbolt server key fingerprint is shown once and has to be accepted
 *   explicitly before the first login;
 * - errors returned to the UI are aggregate/short: no armor, no response
 *   bodies, no decrypted data.
 */

/* eslint-env node */
const fs = require('fs/promises')
const fsSync = require('fs')
const path = require('path')
const crypto = require('crypto')

// The trusted server key fingerprint is the only thing kept on disk, next to
// this file (mode 600). Keys, passphrases and secrets are never written.
const STATE_FILE = path.join(__dirname, '.state.json')

function loadTrustedFingerprint () {
  try {
    const data = JSON.parse(fsSync.readFileSync(STATE_FILE, 'utf8'))
    return typeof data.trustedFingerprint === 'string' ? data.trustedFingerprint : ''
  } catch (e) {
    return ''
  }
}

function saveTrustedFingerprint (fingerprint) {
  try {
    fsSync.writeFileSync(
      STATE_FILE,
      JSON.stringify({ trustedFingerprint: fingerprint }, null, 2),
      { mode: 0o600 }
    )
  } catch (e) {
    // read-only widget folder: the user will just be asked to trust again
  }
}

let openpgpPromise
let activeSession
let pendingFingerprint = ''
const metadataPrivateKeys = new Map()
const publicKeys = new Map()

function openpgp () {
  if (!openpgpPromise) {
    openpgpPromise = import('openpgp')
  }
  return openpgpPromise
}

function normalizeUrl (value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('The Passbolt server URL must use HTTPS (localhost is allowed for testing).')
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function bodyOf (response) {
  return response && response.data && response.data.body
}

function formatFingerprint (fingerprint) {
  const clean = String(fingerprint || '').replace(/\s/g, '')
  const groups = clean.match(/.{1,4}/g)
  return groups ? groups.join(' ') : clean
}

// ---------------------------------------------------------------- transport

async function request (url, options = {}, session = null, retriedAfterRefresh = false) {
  const headers = new Headers(options.headers || {})
  headers.set('Accept', 'application/json')
  if (options.body) {
    headers.set('Content-Type', 'application/json')
  }
  if (session && session.cookie) {
    headers.set('Cookie', session.cookie)
  }
  if (session && session.accessToken) {
    headers.set('Authorization', `Bearer ${session.accessToken}`)
  }
  if (session && session.csrf && options.method && options.method !== 'GET') {
    headers.set('X-CSRF-Token', session.csrf)
  }
  const response = await fetch(url, { ...options, headers, redirect: 'error' })
  const text = await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : null
  } catch (e) {
    throw new Error('The Passbolt server did not return a JSON response.')
  }
  if (!response.ok) {
    const isRefresh = String(url).includes('/auth/jwt/refresh.json')
    const isLogout = String(url).includes('/auth/jwt/logout.json')
    if (
      session && session.accessToken && !retriedAfterRefresh &&
      !isRefresh && !isLogout && [401, 403].includes(response.status)
    ) {
      await refreshJwtSession(session)
      return request(url, options, session, true)
    }
    const message = data && data.header && data.header.message
    throw new Error(message || `Passbolt HTTP error: ${response.status}`)
  }
  return { response, data }
}

async function refreshJwtSession (session) {
  if (session.refreshPromise) {
    return session.refreshPromise
  }
  session.refreshPromise = (async () => {
    const response = await fetch(`${session.baseUrl}/auth/jwt/refresh.json`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.accessToken}`
      },
      body: JSON.stringify({
        user_id: session.userId,
        refresh_token: session.refreshToken
      }),
      redirect: 'error'
    })
    const text = await response.text()
    let data
    try {
      data = text ? JSON.parse(text) : null
    } catch (e) {
      throw new Error('The Passbolt JWT refresh did not return JSON.')
    }
    if (!response.ok) {
      const message = data && data.header && data.header.message
      throw new Error(message || `Passbolt JWT refresh error: ${response.status}`)
    }
    const body = bodyOf({ data })
    if (!body || !body.access_token) {
      throw new Error('Passbolt did not return a new JWT access token.')
    }
    session.accessToken = body.access_token
    if (body.refresh_token) {
      session.refreshToken = body.refresh_token
    }
    const cookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie') || '']
    for (const cookie of cookies) {
      const pair = cookie.split(';', 1)[0]
      const separator = pair.indexOf('=')
      if (separator > 0 && /refresh/i.test(pair.slice(0, separator))) {
        session.refreshToken = pair.slice(separator + 1)
      }
    }
  })()
  try {
    await session.refreshPromise
  } finally {
    session.refreshPromise = null
  }
}

// -------------------------------------------------------------------- crypto

function metadataStageError (stage, error) {
  const wrapped = new Error(error && error.message ? error.message : String(error))
  wrapped.passboltStage = stage
  if (error && error.passboltSignatureFailure) {
    wrapped.passboltSignatureFailure = error.passboltSignatureFailure
  }
  if (error && error.passboltSignatureContext) {
    wrapped.passboltSignatureContext = error.passboltSignatureContext
  }
  return wrapped
}

async function decryptAndVerify (armor, key, verificationKey) {
  const pgp = await openpgp()
  let message
  try {
    message = await pgp.readMessage({ armoredMessage: armor })
  } catch (error) {
    throw metadataStageError('armor', error)
  }
  let result
  try {
    result = await pgp.decrypt({
      message,
      decryptionKeys: key,
      verificationKeys: verificationKey
    })
  } catch (error) {
    throw metadataStageError('decrypt', error)
  }
  if (!result.signatures || result.signatures.length === 0) {
    throw metadataStageError('missingSignature', new Error('Passbolt signature missing.'))
  }
  // Passbolt shared metadata can be co-signed by the writer and the shared
  // metadata key; only signatures from an explicitly trusted key may decide
  // whether the payload is accepted.
  const trustedKeyIds = new Set(
    (Array.isArray(verificationKey) ? verificationKey : [verificationKey])
      .filter(Boolean)
      .flatMap(candidate => candidate.getKeyIDs().map(keyId => keyId.toHex().toLowerCase()))
  )
  const trustedSignatures = result.signatures.filter(signature =>
    signature.keyID && trustedKeyIds.has(signature.keyID.toHex().toLowerCase()))
  if (!trustedSignatures.length) {
    const error = metadataStageError('signatureVerify', new Error('No signature from a trusted Passbolt key was found.'))
    error.passboltSignatureFailure = 'keyMismatch'
    throw error
  }
  for (const signature of trustedSignatures) {
    try {
      await signature.verified
    } catch (cause) {
      const error = metadataStageError('signatureVerify', cause)
      error.passboltSignatureFailure = 'invalid'
      throw error
    }
  }
  return result.data
}

async function readPrivateKey (keyPath, passphrase) {
  const pgp = await openpgp()
  const keyFile = await fs.readFile(keyPath)
  const keyText = keyFile.toString('utf8').replace(/^\uFEFF/, '').trimStart()
  let encryptedKey
  try {
    encryptedKey = keyText.startsWith('-----BEGIN PGP PRIVATE KEY BLOCK-----')
      ? await pgp.readPrivateKey({ armoredKey: keyText })
      : await pgp.readPrivateKey({ binaryKey: new Uint8Array(keyFile) })
  } catch (error) {
    throw new Error(`The selected file is not a readable OpenPGP private key (armored or binary): ${error.message}`)
  }
  const fingerprint = encryptedKey.getFingerprint().toUpperCase()
  let privateKey = encryptedKey
  if (!encryptedKey.isDecrypted()) {
    try {
      privateKey = await pgp.decryptKey({ privateKey: encryptedKey, passphrase: passphrase || '' })
    } catch (error) {
      throw new Error('Could not unlock the selected GPG private key. Check that the file contains the matching private key and enter its passphrase if it is protected.')
    }
  }
  return { privateKey, fingerprint }
}

// --------------------------------------------------------------------- login

async function connect ({ serverUrl, userId, keyPath, passphrase, trustedFingerprint }) {
  if (!serverUrl) {
    throw new Error('Add your Passbolt server URL before connecting.')
  }
  if (!keyPath) {
    throw new Error('Select your exported GPG private key file before connecting.')
  }
  const baseUrl = normalizeUrl(serverUrl)
  const normalizedUserId = String(userId || '').trim()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalizedUserId)) {
    throw new Error('Add your Passbolt user ID (UUID) from the user page URL before connecting.')
  }
  const { privateKey, fingerprint } = await readPrivateKey(keyPath, passphrase)
  const pgp = await openpgp()

  const verifyResponse = await request(`${baseUrl}/auth/verify.json`)
  const verifyBody = bodyOf(verifyResponse)
  if (!verifyBody || !verifyBody.keydata || !verifyBody.fingerprint) {
    throw new Error('The Passbolt server key data is missing.')
  }
  const serverKey = await pgp.readKey({ armoredKey: verifyBody.keydata })
  const serverFingerprint = serverKey.getFingerprint().toUpperCase()
  if (serverFingerprint !== String(verifyBody.fingerprint).replace(/\s/g, '').toUpperCase()) {
    throw new Error('The fingerprint announced by the Passbolt server does not match its key.')
  }
  if (trustedFingerprint && trustedFingerprint.toUpperCase() !== serverFingerprint) {
    throw new Error('The Passbolt server key fingerprint changed. Verify the server before trusting it again.')
  }
  if (!trustedFingerprint) {
    return { needsTrust: true, serverFingerprint, ownFingerprint: fingerprint }
  }

  const verifyToken = crypto.randomUUID()
  const challengePayload = {
    version: '1.0.0',
    domain: baseUrl,
    verify_token: verifyToken,
    verify_token_expiry: Math.floor(Date.now() / 1000) + 600
  }
  const challenge = await pgp.encrypt({
    message: await pgp.createMessage({ text: JSON.stringify(challengePayload) }),
    encryptionKeys: serverKey,
    signingKeys: privateKey
  })
  const login = await request(`${baseUrl}/auth/jwt/login.json`, {
    method: 'POST',
    body: JSON.stringify({ user_id: normalizedUserId, challenge })
  })
  const responseBody = bodyOf(login)
  if (!responseBody || !responseBody.challenge) {
    throw new Error('Passbolt did not return a JWT login challenge. Check that the JWT authentication plugin is enabled on the server.')
  }
  const clearResponse = await decryptAndVerify(responseBody.challenge, privateKey, serverKey)
  let tokenData
  try {
    tokenData = JSON.parse(clearResponse)
  } catch (e) {
    throw new Error('The Passbolt JWT login response was not valid JSON after decryption.')
  }
  if (tokenData.verify_token != null && tokenData.verify_token !== verifyToken) {
    throw new Error('The Passbolt JWT response verify token did not match this login challenge.')
  }
  if (tokenData.version != null && tokenData.version !== '1.0.0') {
    throw new Error('The Passbolt JWT response used an unsupported challenge version.')
  }
  if (tokenData.domain != null) {
    let responseDomain
    try {
      responseDomain = normalizeUrl(tokenData.domain)
    } catch (e) {
      throw new Error('The Passbolt JWT response included an invalid domain.')
    }
    if (responseDomain !== baseUrl) {
      throw new Error('The Passbolt JWT response domain did not match this server.')
    }
  }
  if (!tokenData.access_token || !tokenData.refresh_token) {
    if (Array.isArray(tokenData.mfa_providers) && tokenData.mfa_providers.length) {
      throw new Error(`This Passbolt account requires MFA (${tokenData.mfa_providers.join(', ')}), which this widget does not support yet.`)
    }
    throw new Error('Passbolt did not include usable JWT tokens in its signed response.')
  }

  const session = {
    baseUrl,
    privateKey,
    ownPublicKey: privateKey.toPublic(),
    fingerprint,
    serverFingerprint,
    userId: normalizedUserId,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token
  }
  const me = await request(`${baseUrl}/users/me.json`, {}, session)
  const meBody = bodyOf(me)
  const user = Array.isArray(meBody) ? meBody[0] : meBody
  if (!user || !user.id) {
    throw new Error('Passbolt did not return the signed-in user.')
  }
  session.userId = user.id
  activeSession = session
  metadataPrivateKeys.clear()
  publicKeys.clear()
  publicKeys.set(user.id, session.ownPublicKey)
  return { connected: true, fingerprint: serverFingerprint, ownFingerprint: fingerprint }
}

async function getUserPublicKey (userId) {
  if (publicKeys.has(userId)) {
    return publicKeys.get(userId)
  }
  const pgp = await openpgp()
  const result = await request(`${activeSession.baseUrl}/users/${encodeURIComponent(userId)}.json?contain[gpgkey]=1`, {}, activeSession)
  const body = bodyOf(result)
  const user = Array.isArray(body) ? body[0] : body
  const armored = user && user.gpgkey && (user.gpgkey.armored_key || user.gpgkey.keydata)
  if (!armored) {
    throw new Error('Could not fetch the public key of the resource signer.')
  }
  const key = await pgp.readKey({ armoredKey: armored })
  publicKeys.set(userId, key)
  return key
}

async function getMetadataKey (resource) {
  if (metadataPrivateKeys.has(resource.metadata_key_id)) {
    return metadataPrivateKeys.get(resource.metadata_key_id)
  }
  const result = await request(`${activeSession.baseUrl}/metadata/keys.json?contain[metadata_private_keys]=1`, {}, activeSession)
  const rows = bodyOf(result) || []
  const entry = rows.find(row => row.id === resource.metadata_key_id)
  const encryptedPrivate = entry && (entry.metadata_private_keys || []).find(row =>
    row.user_id === activeSession.userId && (!row.metadata_key_id || row.metadata_key_id === resource.metadata_key_id))
  if (!encryptedPrivate) {
    throw new Error('No shared metadata key is available for this entry.')
  }
  // The API record says who created or modified the per-user key envelope.
  // Verify its signature against the current user and the record's actors.
  const signerIds = [
    ...(encryptedPrivate.data_signed_by_current_user ? [activeSession.userId] : []),
    encryptedPrivate.modified_by,
    encryptedPrivate.created_by
  ].filter((id, index, ids) => typeof id === 'string' && id && ids.indexOf(id) === index)
  const envelopeVerificationKeys = [activeSession.ownPublicKey]
  for (const signerId of signerIds) {
    if (signerId !== activeSession.userId) {
      envelopeVerificationKeys.push(await getUserPublicKey(signerId))
    }
  }
  let clear
  try {
    clear = await decryptAndVerify(encryptedPrivate.data, activeSession.privateKey, envelopeVerificationKeys)
  } catch (error) {
    error.passboltSignatureContext = 'metadataKeyEnvelope'
    throw error
  }
  let keyData
  try {
    keyData = JSON.parse(clear)
  } catch (e) {
    throw new Error('The shared metadata key envelope is not valid JSON.')
  }
  if (!keyData || typeof keyData.armored_key !== 'string' || !keyData.armored_key.trim()) {
    throw new Error('The shared metadata key envelope is missing armored_key.')
  }
  const pgp = await openpgp()
  const key = await pgp.readPrivateKey({ armoredKey: keyData.armored_key })
  if (!key.isPrivate()) {
    throw new Error('The Passbolt metadata key is not a private OpenPGP key.')
  }
  metadataPrivateKeys.set(resource.metadata_key_id, key)
  return key
}

async function readResourceMetadata (resource) {
  if (!resource.metadata) {
    return {
      name: resource.name || '',
      username: resource.username || '',
      uris: resource.uri ? [resource.uri] : [],
      description: resource.description || ''
    }
  }
  let key
  let verificationKey
  if (resource.metadata_key_type === 'shared_key') {
    try {
      key = await getMetadataKey(resource)
    } catch (error) {
      throw metadataStageError(error.passboltStage || 'sharedKey', error)
    }
    verificationKey = key.toPublic()
  } else if (resource.metadata_key_type === 'user_key') {
    key = activeSession.privateKey
    verificationKey = activeSession.ownPublicKey
  } else {
    throw metadataStageError('keyType', new Error('Unsupported metadata key type.'))
  }
  let clear
  try {
    clear = await decryptAndVerify(resource.metadata, key, verificationKey)
  } catch (error) {
    if (error.passboltStage === 'signatureVerify') {
      error.passboltSignatureContext = 'resourceMetadata'
    }
    throw metadataStageError(error.passboltStage || 'pgp', error)
  }
  let metadata
  try {
    metadata = JSON.parse(clear)
  } catch (error) {
    throw metadataStageError('json', error)
  }
  if (metadata.object_type !== 'PASSBOLT_RESOURCE_METADATA' || metadata.resource_type_id !== resource.resource_type_id) {
    throw metadataStageError('contract', new Error('Metadata payload does not match the Passbolt v5 resource contract.'))
  }
  return metadata
}

async function listResources () {
  const resources = []
  const seenIds = new Set()
  let page = 1
  while (page <= 1000) {
    const url = new URL(`${activeSession.baseUrl}/resources.json`)
    url.searchParams.set('contain[resource-type]', '1')
    url.searchParams.set('limit', '2000')
    url.searchParams.set('page', String(page))
    const result = await request(url.toString(), {}, activeSession)
    const rows = bodyOf(result) || []
    const newRows = rows.filter(resource => {
      if (!resource.id || seenIds.has(resource.id)) {
        return false
      }
      seenIds.add(resource.id)
      return true
    })
    resources.push(...newRows)
    const pagination = result.data && result.data.header && result.data.header.pagination
    const limit = Number(pagination && pagination.limit) || 2000
    const count = Number(pagination && pagination.count)
    if (!rows.length || !newRows.length || rows.length < limit || (count > 0 && page * limit >= count)) {
      break
    }
    page++
  }
  return resources
}

function searchableText (value) {
  if (value == null) {
    return []
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return [String(value)]
  }
  if (Array.isArray(value)) {
    return value.flatMap(searchableText)
  }
  if (typeof value === 'object') {
    return Object.entries(value).flatMap(([key, nested]) => [key, ...searchableText(nested)])
  }
  return []
}

function findAddressMatch (value, needle) {
  if (typeof value === 'string') {
    if (!value.toLocaleLowerCase().includes(needle)) {
      return ''
    }
    try {
      const address = value.includes('://') ? value : `https://${value}`
      const url = new URL(address)
      if (['https:', 'http:', 'ssh:', 'ftp:', 'telnet:', 'rdp:'].includes(url.protocol)) {
        return value
      }
    } catch (e) {}
    return ''
  }
  if (Array.isArray(value)) {
    for (const nested of value) {
      const match = findAddressMatch(nested, needle)
      if (match) {
        return match
      }
    }
  } else if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      const match = findAddressMatch(nested, needle)
      if (match) {
        return match
      }
    }
  }
  return ''
}

async function search (query) {
  if (!activeSession) {
    throw new Error('Connect to Passbolt first.')
  }
  const resources = await listResources()
  const needle = String(query || '').trim().toLocaleLowerCase()
  if (!needle) {
    return { matches: [], scanned: resources.length, decrypted: 0, skipped: 0, failureStages: {} }
  }
  const matches = []
  const failureStages = {}
  let decrypted = 0
  let skipped = 0
  for (const resource of resources) {
    if (resource.deleted) {
      continue
    }
    try {
      const metadata = await readResourceMetadata(resource)
      decrypted++
      const uris = Array.isArray(metadata.uris) ? metadata.uris : [metadata.uri].filter(Boolean)
      const text = [
        metadata.name,
        metadata.username,
        metadata.description,
        ...(uris || []),
        ...searchableText(metadata.custom_fields)
      ].filter(Boolean).join('\n').toLocaleLowerCase()
      if (text.includes(needle)) {
        const resourceTypeName = resource.resource_type ? resource.resource_type.name : ''
        const matchingUri = uris.find(uri => String(uri).toLocaleLowerCase().includes(needle))
        const matchingCustomAddress = findAddressMatch(metadata.custom_fields, needle)
        matches.push({
          id: resource.id,
          name: metadata.name || '',
          username: metadata.username || '',
          uri: matchingUri || matchingCustomAddress || uris[0] || '',
          type: resourceTypeName || '',
          createdBy: resource.modified_by || resource.created_by
        })
      }
    } catch (error) {
      // Aggregate diagnostics only: no armor, no server bodies, no decrypted
      // data, no exception text.
      skipped++
      const stage = (error && error.passboltStage) || 'other'
      failureStages[stage] = (failureStages[stage] || 0) + 1
    }
  }
  return {
    matches,
    scanned: resources.filter(resource => !resource.deleted).length,
    decrypted,
    skipped,
    failureStages
  }
}

// GET /secrets/resource/<id> serves both legacy and v5 entries. Asking the v4
// resource view for contain[secret] answers 400 "V4 related fields are not
// supported for V5" as soon as the entry carries encrypted metadata, so that
// endpoint cannot be the one we rely on.
async function getSecret (resourceId) {
  if (!activeSession) {
    throw new Error('The Passbolt session is closed. Connect again.')
  }
  const result = await request(
    `${activeSession.baseUrl}/secrets/resource/${encodeURIComponent(resourceId)}.json`,
    {},
    activeSession
  )
  const secret = bodyOf(result)
  if (!secret || !secret.data) {
    throw new Error('The secret of this entry is not available.')
  }
  const authorId = secret.modified_by || secret.created_by
  const verificationKey = !authorId || authorId === activeSession.userId
    ? activeSession.ownPublicKey
    : await getUserPublicKey(authorId)
  const clear = await decryptAndVerify(secret.data, activeSession.privateKey, verificationKey)
  let payload
  try {
    payload = JSON.parse(clear)
  } catch (e) {
    payload = { password: clear }
  }
  return normalizeSecret(payload)
}

// v4 secrets are flat ({password, description, totp}); v5 wraps them as
// {object_type: PASSBOLT_SECRET_DATA, data: {...}}. v4 keeps the TOTP as a JSON
// string, v5 as an object, so both are normalised here instead of at every
// consumer.
function normalizeSecret (payload) {
  if (!payload || typeof payload !== 'object') {
    return { password: payload == null ? '' : String(payload) }
  }
  let data = payload
  if (payload.object_type === 'PASSBOLT_SECRET_DATA') {
    // v5 nests the fields under data; a flat payload that only carries the
    // marker (some servers and fixtures do that) is left as is
    if (payload.data && typeof payload.data === 'object') {
      data = payload.data
    }
  } else if (payload.object_type) {
    throw new Error('The Passbolt secret type is invalid.')
  }
  const normalized = { ...data }
  if (typeof normalized.totp === 'string' && normalized.totp.trim()) {
    try {
      normalized.totp = JSON.parse(normalized.totp)
    } catch (e) {}
  }
  return normalized
}

async function lock () {
  if (activeSession) {
    const session = activeSession
    try {
      await request(`${session.baseUrl}/auth/jwt/logout.json`, {
        method: 'POST',
        body: JSON.stringify({ refresh_token: session.refreshToken })
      }, session)
    } catch (e) {}
    session.accessToken = ''
    session.refreshToken = ''
    session.privateKey = null
    session.ownPublicKey = null
  }
  activeSession = null
  pendingFingerprint = ''
  metadataPrivateKeys.clear()
  publicKeys.clear()
}

// ------------------------------------------------------------ widget actions

function lockButton () {
  return { label: 'Lock and disconnect', action: 'lock', danger: true }
}

function trustPrompt (serverFingerprint) {
  return {
    message: 'First connection: compare this server key fingerprint with the one shown by your trusted Passbolt administrator, then confirm.',
    messageType: 'warning',
    details: [
      { label: 'Server key', value: formatFingerprint(serverFingerprint), copy: true }
    ],
    buttons: [
      { label: 'Trust this key and connect', action: 'trust', primary: true },
      { label: 'Cancel', action: 'lock', danger: true }
    ]
  }
}

async function connectIfNeeded (config) {
  if (activeSession) {
    // a different server or user in the form means a different session
    let url = ''
    try {
      url = normalizeUrl(config.serverUrl)
    } catch (e) {}
    const userId = String(config.userId || '').trim()
    if (url === activeSession.baseUrl && userId === activeSession.userId) {
      return null
    }
    await lock()
  }
  const result = await connect({
    serverUrl: config.serverUrl,
    userId: config.userId,
    keyPath: config.keyPath,
    passphrase: config.passphrase,
    trustedFingerprint: pendingFingerprint || loadTrustedFingerprint() || undefined
  })
  if (result.needsTrust) {
    pendingFingerprint = result.serverFingerprint
    return result
  }
  pendingFingerprint = ''
  saveTrustedFingerprint(result.fingerprint)
  return null
}

function searchResult (result) {
  const { matches, scanned, decrypted, skipped } = result
  const rows = matches.map(match => ({
    id: match.id,
    name: match.name || '(untitled entry)',
    username: match.username,
    uri: match.uri,
    type: match.type
  }))
  const message = skipped > 0
    ? `Scanned ${scanned} entries, decrypted ${decrypted}, skipped ${skipped} (unreadable metadata or untrusted signature). ${rows.length} match(es).`
    : `Scanned ${scanned} entries, decrypted ${decrypted}. ${rows.length} match(es).`
  return {
    message,
    messageType: skipped > 0 ? 'warning' : 'success',
    table: {
      columns: [
        { key: 'name', title: 'Name' },
        { key: 'username', title: 'Username' },
        { key: 'uri', title: 'URI' },
        { key: 'type', title: 'Type' }
      ],
      rows,
      rowButtons: [
        { label: 'Details', action: 'details' },
        { label: 'SSH', action: 'openSsh' },
        { label: 'FTP', action: 'openFtp' },
        { label: 'Telnet', action: 'openTelnet' },
        { label: 'RDP', action: 'openRdp' }
      ]
    },
    buttons: [lockButton()]
  }
}

async function afterConnect (config) {
  const query = String(config.query || '').trim()
  if (!query) {
    return {
      message: `Connected to ${activeSession.baseUrl}. Enter a keyword and submit again to search.`,
      messageType: 'success',
      details: [
        { label: 'Server key', value: formatFingerprint(activeSession.serverFingerprint), copy: true },
        { label: 'Your key', value: formatFingerprint(activeSession.fingerprint), copy: true }
      ],
      buttons: [lockButton()]
    }
  }
  return searchResult(await search(query))
}

async function run (config = {}) {
  const trust = await connectIfNeeded(config)
  if (trust) {
    return trustPrompt(trust.serverFingerprint)
  }
  return afterConnect(config)
}

async function trust (config = {}) {
  if (!pendingFingerprint) {
    return {
      message: 'Nothing to confirm. Submit the form to connect first.',
      messageType: 'warning'
    }
  }
  const result = await connect({
    serverUrl: config.serverUrl,
    userId: config.userId,
    keyPath: config.keyPath,
    passphrase: config.passphrase,
    trustedFingerprint: pendingFingerprint
  })
  pendingFingerprint = ''
  if (result.needsTrust) {
    // cannot happen: a fingerprint was supplied
    return trustPrompt(result.serverFingerprint)
  }
  saveTrustedFingerprint(result.fingerprint)
  return afterConnect(config)
}

function secretDetails (row, secret) {
  const details = [
    { label: 'Name', value: row.name, copy: true }
  ]
  const username = secret.username || row.username || ''
  if (username) {
    details.push({ label: 'Username', value: username, copy: true })
  }
  // notes and TOTP-only entries have no password; an empty row would just be
  // noise in the panel
  if (secret.password) {
    details.push({ label: 'Password', value: secret.password, secret: true })
  }
  if (row.uri) {
    details.push({ label: 'URI', value: row.uri, copy: true })
  }
  if (secret.description) {
    details.push({ label: 'Description', value: secret.description, copy: true })
  }
  if (secret.totp && typeof secret.totp === 'object') {
    if (secret.totp.secret_key) {
      details.push({ label: 'TOTP secret', value: secret.totp.secret_key, copy: true })
    }
    const settings = [
      secret.totp.digits ? `${secret.totp.digits} digits` : '',
      secret.totp.period ? `${secret.totp.period}s` : '',
      secret.totp.algorithm || ''
    ].filter(Boolean).join(', ')
    if (settings) {
      details.push({ label: 'TOTP settings', value: settings, copy: true })
    }
  }
  Object.entries(secret)
    .filter(([name, value]) => !['object_type', 'password', 'username', 'description', 'totp'].includes(name) && value != null && value !== '')
    .forEach(([name, value]) => {
      details.push({
        label: name,
        value: typeof value === 'string' ? value : JSON.stringify(value),
        copy: true
      })
    })
  return details
}

async function details (row) {
  if (!row || !row.id) {
    throw new Error('No entry selected.')
  }
  const secret = await getSecret(row.id)
  return {
    details: secretDetails(row, secret),
    buttons: [lockButton()]
  }
}

const defaultPorts = { ssh: 22, ftp: 21, telnet: 23, rdp: 3389 }

function buildTab (row, secret, type) {
  let host
  let uri
  try {
    const address = String(row.uri || '').trim()
    uri = new URL(address.includes('://') ? address : `https://${address}`)
    if (!['https:', 'http:', 'ssh:', 'ftp:', 'telnet:', 'rdp:'].includes(uri.protocol)) {
      throw new Error('Unsupported address scheme')
    }
    host = uri.hostname
  } catch (e) {}
  if (!host) {
    throw new Error('This Passbolt entry does not contain a valid host or IP address.')
  }
  const addressScheme = String(row.uri || '').match(/^([a-z][a-z\d+.-]*):\/\//i)
  const uriPortApplies = !addressScheme || addressScheme[1].toLowerCase() === type
  const port = uriPortApplies ? (Number(uri && uri.port) || defaultPorts[type]) : defaultPorts[type]
  const username = secret.username || secret.user || row.username || ''
  const password = secret.password || ''
  const connection = {
    type,
    title: row.name || `${type.toUpperCase()} ${host}`,
    host,
    port,
    username,
    password
  }
  if (type === 'ssh') {
    Object.assign(connection, {
      authType: 'password',
      enableSsh: true,
      enableSftp: true
    })
  } else if (type === 'ftp') {
    connection.user = username
    connection.secure = false
  }
  return connection
}

async function openConnection (row, type) {
  if (!row || !row.id) {
    throw new Error('No entry selected.')
  }
  const secret = await getSecret(row.id)
  const tab = buildTab(row, secret, type)
  return {
    openTab: tab,
    message: `Opening ${type.toUpperCase()} ${tab.username ? tab.username + '@' : ''}${tab.host}:${tab.port}`,
    messageType: 'success',
    buttons: [lockButton()]
  }
}

async function lockAction () {
  await lock()
  return {
    message: 'Passbolt locked. JWT tokens, keys and decrypted data were cleared from memory.',
    messageType: 'info'
  }
}

module.exports = {
  run,
  trust,
  details,
  openSsh: (row) => openConnection(row, 'ssh'),
  openFtp: (row) => openConnection(row, 'ftp'),
  openTelnet: (row) => openConnection(row, 'telnet'),
  openRdp: (row) => openConnection(row, 'rdp'),
  lock: lockAction
}
