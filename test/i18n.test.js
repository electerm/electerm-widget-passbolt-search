const test = require('node:test')
const assert = require('node:assert/strict')

const pkg = require('../package.json')
const conf = pkg.electerm
const zh = conf.i18n && conf.i18n.zh_cn

test('zh_cn translates every string the host renders from this manifest', () => {
  assert.ok(zh, 'missing electerm.i18n.zh_cn')
  assert.equal(typeof zh.name, 'string')
  assert.ok(zh.name.length)
  assert.equal(typeof zh.description, 'string')
  assert.ok(zh.description.length)
  if (conf.submitLabel) {
    assert.equal(typeof zh.submitLabel, 'string')
  }
  for (const config of conf.configs || []) {
    const tr = zh.configs && zh.configs[config.name]
    assert.ok(tr, `missing translation for config ${config.name}`)
    assert.equal(typeof tr.label, 'string')
    if (config.description) {
      assert.equal(typeof tr.description, 'string')
    }
    for (const choice of config.choices || []) {
      assert.ok(tr.choices && typeof tr.choices[choice.value] === 'string',
        `missing translation for choice ${choice.value}`)
    }
  }
  assert.equal(pkg.version, conf.version)
})
