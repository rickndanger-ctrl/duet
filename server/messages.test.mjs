import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Messages, fakeMessages, invalidMessageInput, prepareMessageWrite } from './messages.mjs'

test('a contact name becomes a phone number; numbers pass through', async () => {
  assert.deepEqual(await fakeMessages.resolve('Sam'), { name: 'Sam Lee', handle: '+15035550100' })
  assert.deepEqual(await fakeMessages.resolve('(503) 555-0100'), { name: '(503) 555-0100', handle: '5035550100' })
  await assert.rejects(fakeMessages.resolve('Nobody'), /no contact/)
})

test('a name that fits several people asks which one', async () => {
  const m = new Messages(async () => [{ name: 'Sam Lee', handles: ['5035550100'] }, { name: 'Sam Ortiz', handles: ['5035550111'] }])
  await assert.rejects(m.resolve('Sam'), /several contacts match "Sam": Sam Lee, Sam Ortiz/)
  assert.equal((await m.resolve('Sam Ortiz')).handle, '+15035550111')
})

test('sending a text shows the draft first and sends only when run', async () => {
  const sent = []
  const m = new Messages(async (args, input) => (args[0] === 'who' ? [{ name: 'Sam Lee', handles: ['5035550100'] }] : (sent.push([args, input]), { sent: true })))
  const w = await prepareMessageWrite(m, 'messages_send', { to: 'sam', body: ' On my way! ' })
  assert.equal(w.verb, 'Send')
  assert.equal(w.prompt, 'Text Sam Lee\n"On my way!"')
  assert.equal(sent.length, 0)
  await w.run()
  assert.deepEqual(sent, [[['send', '+15035550100'], 'On my way!']])
})

test('bad tool input is refused', () => {
  assert.match(invalidMessageInput('messages_send', { to: 'sam' }), /body/)
  assert.match(invalidMessageInput('messages_send', { to: 'sam', body: 'x'.repeat(1001) }), /too long/)
  assert.match(invalidMessageInput('messages_thread', {}), /contact/)
  assert.equal(invalidMessageInput('messages_recent', {}), '')
})
