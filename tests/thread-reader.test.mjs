import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { RpcError } from '../scripts/rpc-client.mjs';
import { committedCursor, describePage, exportCursorDecoder, readLastReply } from '../scripts/thread-reader.mjs';

const { Zip, ZipDeflate, ZipPassThrough, zipSync } = createRequire(join(
  process.env.DSH_ROOT || '/Users/zhuoran/Programs/deepseek-harness',
  'packages/session-query/session-log-export/package.json',
))('fflate');

const sessionId = 'session-reader-fixture';
const header = { type: 'session', id: sessionId, version: 1 };
const zipOptions = { mtime: new Date(946684800000) };
const text = value => ({ type: 'text', text: value });
const image = { type: 'image', source: { type: 'url', url: 'https://fixture.invalid/image.png' } };
const event = (type, seq, data = {}, time = seq * 100) => ({ type, seq, time, data });
const records = (...events) => events.map(event => ({ event }));
const prompt = (seq, content, source = { kind: 'user' }) => event('user/message', seq, {
  content: typeof content === 'string' ? [text(content)] : content, source,
});
const response = (seq, content, turn = 'turn-1', extra = {}) => event('assistant/message', seq, {
  turn, message: { role: 'assistant', content: typeof content === 'string' ? [text(content)] : content }, ...extra,
});
const turnStart = (seq, turn = 'turn-1') => event('turn/start', seq, { turn });
const turnEnd = (seq, kind = 'completed', turn = 'turn-1') => event('turn/end', seq, { turn, reason: { kind } });
const summary = (overrides = {}) => ({
  sessionId, running: false, blank: false,
  projections: { values: { title: 'Projected title', sessionListMetadata: { lastPromptAt: 100 } } },
  ...overrides,
});
const jsonl = (events = [], first = header) => [first, ...events].map(value => JSON.stringify(value)).join('\n') + '\n';
const bytes = value => typeof value === 'string' ? Buffer.from(value) : value;

function archive(log, { name = 'session.v1.jsonl', level = 6, attachments = [] } = {}) {
  return Buffer.from(zipSync(Object.fromEntries([[name, bytes(log)], ...attachments.map(
    ([name, value]) => [name, bytes(value)],
  )]), { ...zipOptions, level }));
}

function streamingArchive(log, { compressed = true, attachments = [] } = {}) {
  const chunks = [];
  let rootEnd;
  const zip = new Zip((error, chunk) => {
    assert.ifError(error);
    chunks.push(chunk);
  });
  for (const [name, value] of [['session.v1.jsonl', log], ...attachments]) {
    const file = compressed ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name);
    file.mtime = zipOptions.mtime;
    zip.add(file);
    const content = bytes(value);
    const middle = Math.floor(content.length / 2);
    file.push(content.subarray(0, middle), false);
    file.push(content.subarray(middle), true);
    rootEnd ??= chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  }
  zip.end();
  return { value: Buffer.concat(chunks), rootEnd };
}

function chunksOf(value, size) {
  const chunks = [];
  for (let offset = 0; offset < value.length; offset += size) chunks.push(value.subarray(offset, offset + size));
  return chunks;
}

function decode(value, { chunkSize = value.length || 1, ...limits } = {}) {
  const decoder = exportCursorDecoder(sessionId, limits);
  for (const chunk of chunksOf(value, chunkSize)) decoder.push(chunk);
  decoder.push(new Uint8Array(), true);
  return decoder.result();
}

function localPayload(value, offset = 0) {
  assert.equal(value.readUInt32LE(offset), 0x04034b50);
  const start = offset + 30 + value.readUInt16LE(offset + 26) + value.readUInt16LE(offset + 28);
  return { start, end: start + value.readUInt32LE(offset + 18) };
}

function errorCode(code) {
  return error => {
    assert.ok(error instanceof RpcError, `expected RpcError, received ${error}`);
    assert.equal(error.code, code);
    return true;
  };
}

function downloadFixture(chunks, { contentType = 'application/zip', body = true } = {}) {
  const state = { reads: 0, readerCancels: 0, bodyCancels: 0, readers: 0 };
  const reader = {
    async read() {
      const index = state.reads++;
      if (index >= chunks.length) return { done: true };
      if (chunks[index] instanceof Error) throw chunks[index];
      return { done: false, value: chunks[index] };
    },
    async cancel() { state.readerCancels++; },
  };
  return {
    state,
    response: {
      headers: new Headers(contentType === null ? {} : { 'content-type': contentType }),
      body: body ? {
        getReader() { state.readers++; return reader; },
        async cancel() { state.bodyCancels++; },
      } : null,
    },
  };
}

function clientFixture({ items = [summary()], pages = [], download, children = [] } = {}) {
  const calls = [];
  let page = 0;
  return {
    calls,
    client: {
      async request(method, args) {
        calls.push({ method, args: structuredClone(args) });
        if (method === 'session/list') return { items };
        if (method === 'subagents/list') return { entries: children, parentAvailable: true };
        assert.equal(method, 'session/page', 'reader must not follow or otherwise attach to a session');
        assert.ok(page < pages.length, 'reader requested an unexpected additional page');
        const result = pages[page++];
        if (result instanceof Error) throw result;
        return structuredClone(result);
      },
      async openDownload(path) {
        calls.push({ method: 'download', path });
        assert.ok(download, 'reader unexpectedly requested an export');
        return download.response;
      },
      async streamUntil() { assert.fail('reader must not open a live session stream'); },
    },
  };
}

function pageArgs(throughSeq, { maxMessages = 8, beforeSeq } = {}) {
  return { request: {
    address: { kind: 'session', sessionId }, throughSeq, maxMessages, stepDetail: 'collapsed',
    ...(beforeSeq === undefined ? {} : { beforeSeq }),
  } };
}

function exportPath(id = sessionId) {
  return '/api/session.export?' + new URLSearchParams({ sessionId: id, includeDescendants: 'false' });
}

test('exportCursorDecoder streams only the first root log and preserves its exact committed cursor', async t => {
  const start = turnStart(3);
  const end = turnEnd(8);
  const log = jsonl([
    event('session/title', 0, { title: 'Old title' }), prompt(1, 'Human question'), start,
    response(5, 'A reply'), end, prompt(13, 'Injected reminder', { kind: 'system' }),
    event('session/title', 21, { title: 'Committed title' }), event('fixture/unknown', 34),
  ]);
  for (const name of ['session.jsonl', 'session.v1.jsonl', 'session.v12.jsonl']) {
    for (const level of [0, 6]) await t.test(`${name}, compression ${level}`, () => {
      const result = decode(archive(log, { name, level, attachments: [
        ['attachments/not-json.txt', '{not JSON'],
        ['children/session.v1.jsonl', jsonl([response(999, 'Wrong child')], { ...header, id: 'child-fixture' })],
      ] }), { chunkSize: 7 });
      assert.deepEqual(result, {
        header, title: 'Committed title', cursor: 34, decodedBytes: Buffer.byteLength(log),
        lastInteractionAt: 500, lastPromptAt: 100, lastPromptSeq: 1,
        lastTurnStart: { seq: 3, time: 300, turn: 'turn-1' },
        lastTurnEnd: { seq: 8, time: 800, turn: 'turn-1', reason: { kind: 'completed' } },
      });
    });
  }
});

test('exportCursorDecoder accepts data-descriptor ZIP streams, not just known-size ZIP entries', async t => {
  for (const compressed of [false, true]) await t.test(compressed ? 'deflated' : 'stored', () => {
    const log = jsonl([prompt(0, 'Question'), response(2, 'Answer'), turnEnd(4)]);
    const { value } = streamingArchive(log, { compressed, attachments: [['attachments/blob', 'not JSON']] });
    assert.equal(value.readUInt16LE(6) & 8, 8);
    const result = decode(value, { chunkSize: 1 });
    assert.equal(result.cursor, 4);
    assert.equal(result.decodedBytes, Buffer.byteLength(log));
    assert.equal(result.lastPromptAt, 0);
    assert.equal(result.lastInteractionAt, 200);
  });
});

test('exportCursorDecoder waits for the complete root entry but not the ZIP directory', () => {
  const log = jsonl([event('fixture/unknown', 0)]);
  const value = archive(log, { level: 0, attachments: [['attachments/blob', 'ignored']] });
  const { end } = localPayload(value);
  const decoder = exportCursorDecoder(sessionId);
  assert.equal(decoder.complete, false);
  assert.throws(() => decoder.result(), errorCode('BAD_EXPORT'));
  decoder.push(value.subarray(0, end - 1));
  assert.equal(decoder.complete, false);
  assert.throws(() => decoder.result(), errorCode('BAD_EXPORT'));
  decoder.push(value.subarray(end - 1, end));
  assert.equal(decoder.complete, true);
  assert.equal(decoder.result().cursor, 0);
  assert.equal(decoder.result().decodedBytes, Buffer.byteLength(log));
});

test('exportCursorDecoder decodes split UTF-8 scalars and counts bytes, not characters', () => {
  const title = '雪 🌋 café';
  const log = jsonl([event('session/title', 0, { title }), prompt(2, '你好'), response(3, '🧭')]);
  assert.ok(Buffer.byteLength(log) > log.length);
  const result = decode(archive(log, { level: 0 }), { chunkSize: 1 });
  assert.equal(result.title, title);
  assert.equal(result.decodedBytes, Buffer.byteLength(log));
  assert.equal(result.lastInteractionAt, 300);
  assert.equal(result.lastPromptAt, 200);
});

test('exportCursorDecoder includes image-only human activity but excludes injections and non-text assistant output', () => {
  const log = jsonl([
    prompt(1, 'Question'), response(2, 'Reply'), prompt(4, [image]),
    prompt(5, 'Injected task', { kind: 'system' }), response(6, [image]), response(7, ''),
  ]);
  const result = decode(archive(log));
  assert.equal(result.cursor, 7);
  assert.equal(result.lastPromptAt, 400);
  assert.equal(result.lastInteractionAt, 400);
});

test('exportCursorDecoder permits blank lines, CRLF, and a final JSON record without a newline', () => {
  const log = '\r\n' + JSON.stringify(header) + '\r\n \t\r\n'
    + JSON.stringify(event('session/title', 7, { title: 'Last line' }));
  assert.equal(decode(archive(log), { chunkSize: 3 }).title, 'Last line');
  assert.deepEqual(decode(archive(jsonl())), {
    header, title: undefined, cursor: -1, decodedBytes: Buffer.byteLength(jsonl()),
    lastInteractionAt: null, lastPromptAt: null, lastPromptSeq: null, lastTurnStart: null, lastTurnEnd: null,
  });
});

test('exportCursorDecoder rejects a non-root first entry even if a valid root follows', async t => {
  for (const name of ['attachments/', 'manifest.json', 'children/session.jsonl', '../session.jsonl',
    'session.vx.jsonl', 'session.jsonl.extra']) await t.test(name, () => {
    assert.throws(() => decode(archive(jsonl(), { name, attachments: [['session.v1.jsonl', jsonl()]] })),
      errorCode('BAD_EXPORT'));
  });
});

test('exportCursorDecoder rejects wrong session identity, absent headers, and malformed JSONL', async t => {
  for (const [name, log] of [
    ['wrong session', jsonl([], { ...header, id: 'another-session' })],
    ['wrong header type', jsonl([], { type: 'fixture/unknown', id: sessionId })],
    ['empty root', ''], ['only whitespace', '\n \r\n'], ['non-JSON header', '{'], ['null header', 'null\n'],
    ['malformed later record', jsonl() + '{broken\n'], ['truncated last JSON', jsonl() + '{"seq":0'],
    ['null later record', jsonl() + 'null\n'],
  ]) await t.test(name, () => {
    assert.throws(() => decode(archive(log), { chunkSize: 5 }), errorCode('BAD_EXPORT'));
  });
});

test('exportCursorDecoder rejects invalid UTF-8 even when the ZIP itself is valid', async t => {
  for (const [name, suffix] of [
    ['invalid continuation', [0xc3, 0x28]], ['truncated scalar', [0xf0, 0x9f, 0x8c]],
  ]) await t.test(name, () => {
    const log = Buffer.concat([Buffer.from(jsonl() + '{"seq":0,"value":"'), Buffer.from(suffix)]);
    assert.throws(() => decode(archive(log, { level: 0 }), { chunkSize: 1 }), errorCode('BAD_EXPORT'));
  });
});

test('exportCursorDecoder rejects non-increasing or unsafe event sequences', async t => {
  for (const [name, seq] of [
    ['duplicate', 3], ['backwards', 2], ['negative', -1], ['fractional', 3.5],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1], ['string', '4'], ['missing', undefined],
  ]) await t.test(name, () => {
    assert.throws(() => decode(archive(jsonl([event('fixture/unknown', 3), { type: 'fixture/unknown', seq }]))),
      errorCode('BAD_EXPORT'));
  });
  assert.equal(decode(archive(jsonl([event('fixture/unknown', Number.MAX_SAFE_INTEGER)]))).cursor,
    Number.MAX_SAFE_INTEGER);
});

test('exportCursorDecoder rejects malformed ZIPs and root entries truncated before EOF', async t => {
  const value = archive(jsonl([prompt(1, 'Question')]), { level: 0 });
  const { start, end } = localPayload(value);
  const corrupt = archive(jsonl([prompt(1, 'Question')]));
  corrupt[localPayload(corrupt).start] = 0x07;
  for (const [name, input] of [
    ['empty bytes', Buffer.alloc(0)], ['non-ZIP bytes', Buffer.from('not a zip')],
    ['no entries', Buffer.from(zipSync({}, zipOptions))], ['partial ZIP header', value.subarray(0, 12)],
    ['partial root header', value.subarray(0, start + 5)], ['partial root content', value.subarray(0, end - 1)],
    ['invalid deflate block', corrupt],
  ]) await t.test(name, () => assert.throws(() => decode(input), errorCode('BAD_EXPORT')));
});

test('exportCursorDecoder enforces inclusive decoded-log and UTF-8 line byte limits', async t => {
  const log = jsonl([event('session/title', 0, { title: '🌋'.repeat(32) })]);
  const maxLogBytes = Buffer.byteLength(log);
  const maxLineBytes = Math.max(...log.split('\n').map(line => Buffer.byteLength(line)));
  assert.ok(maxLineBytes > Math.max(...log.split('\n').map(line => line.length)));
  for (const level of [0, 6]) {
    const value = archive(log, { level });
    for (const chunkSize of [value.length, 1]) {
      await t.test(`compression ${level}, chunk ${chunkSize}, exact limits`, () => {
        assert.equal(decode(value, { chunkSize, maxLogBytes, maxLineBytes }).decodedBytes, maxLogBytes);
      });
      for (const [name, limits] of [
        ['decoded log', { maxLogBytes: maxLogBytes - 1 }],
        ['decoded line', { maxLineBytes: maxLineBytes - 1 }],
      ]) await t.test(`compression ${level}, chunk ${chunkSize}, oversized ${name}`, () => {
        assert.throws(() => decode(value, { chunkSize, ...limits }), errorCode('EXPORT_LIMIT'));
      });
    }
  }
});

test('exportCursorDecoder bounds an unfinished JSONL line before receiving the rest of the root', () => {
  const log = jsonl([event('session/title', 0, { title: 'x'.repeat(512) })]);
  const value = archive(log, { level: 0 });
  const { start } = localPayload(value);
  const decoder = exportCursorDecoder(sessionId, { maxLineBytes: 128 });
  assert.throws(() => decoder.push(value.subarray(0, start + Buffer.byteLength(jsonl()) + 129)),
    errorCode('EXPORT_LIMIT'));
  assert.equal(decoder.complete, false);
});

test('committedCursor cancels immediately after the root without reading attachments or the directory', async () => {
  const log = jsonl([prompt(1, 'Question'), response(4, 'Reply')]);
  const value = archive(log, { level: 0, attachments: [['attachments/blob', 'never read']] });
  const { end } = localPayload(value);
  const rootChunks = chunksOf(value.subarray(0, end), 17);
  const download = downloadFixture([...rootChunks, new Error('attachment stream must not be read')]);
  const fixture = clientFixture({ download });
  const result = await committedCursor(fixture.client, sessionId);
  assert.equal(result.cursor, 4);
  assert.equal(result.downloadedBytes, end);
  assert.equal(result.decodedBytes, Buffer.byteLength(log));
  assert.deepEqual(download.state, { reads: rootChunks.length, readerCancels: 1, bodyCancels: 0, readers: 1 });
  assert.deepEqual(fixture.calls, [{ method: 'download', path: exportPath() }]);
});

test('committedCursor cancels a data-descriptor ZIP without waiting for the next entry', async t => {
  for (const compressed of [false, true]) await t.test(compressed ? 'deflated' : 'stored', async () => {
    const log = jsonl([prompt(1, 'Question'), response(2, 'Reply')]);
    const { value, rootEnd } = streamingArchive(log, { compressed, attachments: [['attachments/blob', 'ignored']] });
    const download = downloadFixture([value.subarray(0, rootEnd), new Error('next ZIP entry must not be read')]);
    const fixture = clientFixture({ download });
    const result = await committedCursor(fixture.client, sessionId);
    assert.equal(result.cursor, 2);
    assert.equal(result.downloadedBytes, rootEnd);
    assert.equal(result.decodedBytes, Buffer.byteLength(log));
    assert.equal(download.state.reads, 1);
    assert.equal(download.state.readerCancels, 1);
  });
});

test('committedCursor does not inflate or parse attachments already present in the root network chunk', async () => {
  const log = jsonl([event('fixture/unknown', 11)]);
  const value = archive(log, { attachments: [['attachments/broken-deflate.bin', 'x'.repeat(4096)]] });
  const attachment = localPayload(value, localPayload(value).end);
  value[attachment.start] = 0x07;
  const download = downloadFixture([value, new Error('must already have cancelled')]);
  const fixture = clientFixture({ download });
  const result = await committedCursor(fixture.client, sessionId, { maxLogBytes: Buffer.byteLength(log) });
  assert.equal(result.cursor, 11);
  assert.equal(result.decodedBytes, Buffer.byteLength(log));
  assert.equal(result.downloadedBytes, value.length);
  assert.equal(download.state.reads, 1);
  assert.equal(download.state.readerCancels, 1);
});

test('committedCursor URL-encodes the requested session identity', async () => {
  const id = 'session/fixture + 雪&includeDescendants=true';
  const download = downloadFixture([archive(jsonl([], { ...header, id }))]);
  const fixture = clientFixture({ download });
  assert.equal((await committedCursor(fixture.client, id)).header.id, id);
  const path = new URL(fixture.calls[0].path, 'https://fixture.invalid');
  assert.equal(path.pathname, '/api/session.export');
  assert.deepEqual([...path.searchParams], [['sessionId', id], ['includeDescendants', 'false']]);
});

test('committedCursor rejects non-ZIP or bodyless responses before taking a reader', async t => {
  for (const [name, options] of [
    ['HTML', { contentType: 'text/html' }], ['missing content type', { contentType: null }],
    ['missing body', { body: false }],
  ]) await t.test(name, async () => {
    const download = downloadFixture([], options);
    const fixture = clientFixture({ download });
    await assert.rejects(committedCursor(fixture.client, sessionId), errorCode('BAD_EXPORT'));
    assert.equal(download.state.readers, 0);
    assert.equal(download.state.reads, 0);
    assert.equal(download.state.bodyCancels, options.body === false ? 0 : 1);
  });
});

test('committedCursor bounds total downloaded bytes inclusively and always cancels on limits', async () => {
  const log = jsonl([event('fixture/unknown', 0)]);
  const value = archive(log, { level: 0 });
  const { end } = localPayload(value);
  for (const limit of [end, end - 1]) {
    const download = downloadFixture(chunksOf(value.subarray(0, end), 13));
    const fixture = clientFixture({ download });
    const operation = committedCursor(fixture.client, sessionId, { maxDownloadBytes: limit });
    if (limit === end) assert.equal((await operation).downloadedBytes, end);
    else await assert.rejects(operation, errorCode('EXPORT_LIMIT'));
    assert.equal(download.state.readerCancels, 1);
  }
});

test('committedCursor cancels on bad exports, decoded limits, and transport read errors', async t => {
  const log = jsonl([prompt(1, 'x'.repeat(512))]);
  const value = archive(log, { level: 0 });
  const readError = new Error('fixture download failed');
  for (const [name, chunks, limits, code] of [
    ['premature EOF', [value.subarray(0, localPayload(value).end - 1)], {}, 'BAD_EXPORT'],
    ['wrong identity', [archive(jsonl([], { ...header, id: 'wrong' }))], {}, 'BAD_EXPORT'],
    ['decoded byte limit', [value], { maxLogBytes: 32 }, 'EXPORT_LIMIT'],
    ['line byte limit', [value], { maxLineBytes: 128 }, 'EXPORT_LIMIT'],
    ['read error', [value.subarray(0, 12), readError], {}, null],
  ]) await t.test(name, async () => {
    const download = downloadFixture(chunks);
    const fixture = clientFixture({ download });
    await assert.rejects(committedCursor(fixture.client, sessionId, limits), code ? errorCode(code) : error => error === readError);
    assert.equal(download.state.readerCancels, 1);
    assert.equal(fixture.calls.length, 1);
  });
});

test('describePage identifies genuine human prompts rather than later injected user-role messages', () => {
  const input = records(
    prompt(8, 'Harness injection', { kind: 'system' }),
    response(4, [text('First paragraph'), text('Second paragraph')]), turnEnd(5),
    prompt(7, 'Subagent injection', { kind: 'subagent' }),
    event('user/message', 9, { content: [text('Missing provenance')] }),
    prompt(1, [text('Actual question'), text('More context')]),
  );
  const original = structuredClone(input);
  const result = describePage(input, {
    header, cursor: 9, lastTurnEnd: { seq: 5, time: 500, turn: 'turn-1', reason: { kind: 'completed' } },
  }, summary());
  assert.deepEqual(result.lastPrompt, { seq: 1, time: 100, text: 'Actual question\nMore context', hasAttachments: false });
  assert.deepEqual(result.lastResponse, {
    seq: 4, time: 400, turn: 'turn-1', text: 'First paragraph\nSecond paragraph', kind: 'final',
  });
  assert.deepEqual(result.lastFinalReply, result.lastResponse);
  assert.equal(result.newerPromptWithoutResponse, false);
  assert.equal(result.lastInteractionAt, 400);
  assert.deepEqual(input, original);
});

test('describePage keeps an image-only human follow-up as the newest unanswered prompt', () => {
  const result = describePage(records(
    prompt(1, 'Earlier question'), response(4, 'Earlier final reply'), turnEnd(5),
    prompt(7, [image]), prompt(8, 'Injected continuation', { kind: 'system' }),
  ), {
    header, cursor: 9, lastPromptAt: 700, lastInteractionAt: 700,
    lastTurnStart: { seq: 9, time: 900, turn: 'turn-2' },
    lastTurnEnd: { seq: 5, time: 500, turn: 'turn-1', reason: { kind: 'completed' } },
  }, summary());
  assert.deepEqual(result.lastPrompt, { seq: 7, time: 700, text: '', hasAttachments: true });
  assert.equal(result.lastPromptAt, 700);
  assert.equal(result.lastInteractionAt, 700);
  assert.equal(result.lastFinalReply.text, 'Earlier final reply');
  assert.equal(result.newerPromptWithoutResponse, true);
  assert.equal(result.lastTurnStatus, 'unfinished');
});

test('describePage distinguishes completed replies from tool progress and interrupted turns', async t => {
  for (const [name, content, extra, endKind, kind] of [
    ['completed text', 'Final text', {}, 'completed', 'final'],
    ['tool-call progress', [text('Checking'), { type: 'tool-call', id: 'fixture-call', name: 'fixture' }], {}, 'completed', 'progress'],
    ['still running', 'Working', {}, undefined, 'progress'],
    ['message interrupted', 'Partial text', { interrupted: true }, 'completed', 'interrupted'],
    ['turn cancelled', 'Partial text', {}, 'cancelled', 'interrupted'],
    ['turn failed', 'Partial text', {}, 'error', 'interrupted'],
  ]) await t.test(name, () => {
    const events = [response(2, content, 'turn-1', extra)];
    if (endKind !== undefined) events.push(turnEnd(3, endKind));
    const result = describePage(records(...events), { header, cursor: 3 }, summary());
    assert.equal(result.lastResponse.kind, kind);
    assert.equal(result.lastFinalReply?.text ?? null, kind === 'final' ? 'Final text' : null);
  });
});

test('describePage uses exported turn-end metadata when the end is outside the history page', () => {
  const lastTurnEnd = { seq: 10, time: 1000, turn: 'turn-1', reason: { kind: 'completed' } };
  const result = describePage(records(response(8, 'Reply')), { header, cursor: 10, lastTurnEnd });
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.lastResponse.kind, 'final');
  assert.equal(result.lastTurnStatus, 'completed');
  assert.deepEqual(result.lastTurnEnd, lastTurnEnd);
});

test('describePage retains the earlier final reply when newer text is progress or interrupted', async t => {
  for (const interrupted of [false, true]) await t.test(interrupted ? 'interrupted' : 'progress', () => {
    const result = describePage(records(
      response(2, 'Completed answer'), turnEnd(3), turnStart(5, 'turn-2'),
      response(6, 'New partial answer', 'turn-2', { interrupted }),
    ), { header, cursor: 6 }, summary());
    assert.equal(result.lastResponse.kind, interrupted ? 'interrupted' : 'progress');
    assert.equal(result.lastResponse.text, 'New partial answer');
    assert.equal(result.lastFinalReply.text, 'Completed answer');
  });
});

test('describePage ignores assistant entries without text and reports exported unfinished state', () => {
  const result = describePage([
    ...records(response(2, 'Visible reply'), turnEnd(3), response(6, [image]), response(7, ''),
      response(8, [{ type: 'tool-call', id: 'fixture-call', name: 'fixture' }])),
    { kind: 'collapsed-step', covers: { from: 4, to: 5 } },
  ], {
    header, cursor: 9, title: 'Export title', lastInteractionAt: 200,
    lastTurnStart: { seq: 9, time: 900, turn: 'turn-2' },
    lastTurnEnd: { seq: 3, time: 300, turn: 'turn-1', reason: { kind: 'completed' } },
  }, summary({ running: true }));
  assert.equal(result.lastResponse.seq, 2);
  assert.equal(result.lastFinalReply.text, 'Visible reply');
  assert.equal(result.lastTurnStatus, 'running');
  assert.equal(result.running, true);
  assert.equal(result.title, 'Export title');
  assert.equal(result.throughSeq, 9);
  assert.equal(result.lastInteractionAt, 200);
});

test('describePage uses summary metadata only when the exported values are absent', () => {
  const result = describePage([], { cursor: 4 }, summary({
    projections: { values: { title: 'List title', sessionListMetadata: { lastPromptAt: 400 } } },
  }));
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.title, 'List title');
  assert.equal(result.lastPromptAt, 400);
  assert.equal(result.lastPrompt, null);
  assert.equal(result.lastResponse, null);
  assert.equal(result.lastFinalReply, null);
  assert.equal(result.newerPromptWithoutResponse, true);
  assert.equal(result.lastTurnStatus, 'unknown');
  const noActivity = describePage([], { header, cursor: -1 });
  assert.equal(noActivity.lastInteractionAt, null);
  assert.equal(noActivity.newerPromptWithoutResponse, false);
});

test('readLastReply passes the exact export cursor to session/page without session/follow', async () => {
  const events = [prompt(1, 'Question'), turnStart(2), response(4, 'Committed reply'), turnEnd(5),
    event('session/title', 13, { title: 'Exported title' }), event('fixture/unknown', 41)];
  const log = jsonl(events);
  const value = archive(log);
  const download = downloadFixture([value, new Error('export should be cancelled')]);
  const fixture = clientFixture({
    items: [
      summary({ sessionId: 'session-unrelated', blank: true }),
      summary({ projections: { values: { title: 'Stale title', sessionListMetadata: { lastPromptAt: 9999 } } } }),
    ],
    download, pages: [{ records: records(...events.slice(0, 4)), hasMore: true }],
  });
  const before = Date.now();
  const result = await readLastReply(fixture.client, sessionId, { maxMessages: 3 });
  assert.deepEqual(fixture.calls, [
    { method: 'session/list', args: { _request: {} } },
    { method: 'download', path: exportPath() },
    { method: 'session/page', args: pageArgs(41, { maxMessages: 3 }) },
  ]);
  assert.equal(result.throughSeq, 41);
  assert.equal(result.cursorSource, 'committed-export');
  assert.equal(result.title, 'Exported title');
  assert.equal(result.lastPromptAt, 100);
  assert.equal(result.lastFinalReply.text, 'Committed reply');
  assert.equal(result.downloadedBytes, value.length);
  assert.equal(result.decodedBytes, Buffer.byteLength(log));
  assert.ok(Number.isSafeInteger(result.snapshotAt) && result.snapshotAt >= before && result.snapshotAt <= Date.now());
  assert.equal(download.state.readerCancels, 1);
});

test('readLastReply with an explicit cursor, including zero, bypasses export', async t => {
  for (const throughSeq of [0, 23]) await t.test(`cursor ${throughSeq}`, async () => {
    const fixture = clientFixture({ pages: [{ records: records(response(throughSeq, 'Explicit-cut reply')), hasMore: false }] });
    const result = await readLastReply(fixture.client, sessionId, { throughSeq });
    assert.deepEqual(fixture.calls, [
      { method: 'session/list', args: { _request: {} } },
      { method: 'session/page', args: pageArgs(throughSeq) },
    ]);
    assert.equal(result.throughSeq, throughSeq);
    assert.equal(result.cursorSource, 'explicit-cut');
    assert.equal(result.lastResponse.text, 'Explicit-cut reply');
    assert.equal(result.lastResponse.kind, 'progress');
    assert.equal(result.downloadedBytes, undefined);
  });
});

test('readLastReply accepts a supplied summary without listing or attaching to the session', async () => {
  const fixture = clientFixture({ pages: [{ records: [], hasMore: false }] });
  const result = await readLastReply(fixture.client, sessionId, { throughSeq: 5, summary: summary() });
  assert.deepEqual(fixture.calls, [{ method: 'session/page', args: pageArgs(5) }]);
  assert.equal(result.title, 'Projected title');
  assert.equal(result.lastResponse, null);
});

test('readLastReply refuses unknown and subagent sessions before export or page requests', async t => {
  for (const [name, items, options, code, expectedCalls] of [
    ['empty listing', [], {}, 'NOT_FOUND', [{ method: 'session/list', args: { _request: {} } }]],
    ['unlisted session', [summary({ sessionId: 'session-unrelated' })], {}, 'NOT_FOUND', [{ method: 'session/list', args: { _request: {} } }]],
    ['listed child', [summary({ origin: 'subagent' })], {}, 'SUBAGENT_ADDRESS', [{ method: 'session/list', args: { _request: {} } }]],
    ['supplied blank child', [], { summary: summary({ origin: 'subagent', blank: true }) }, 'SUBAGENT_ADDRESS', []],
  ]) await t.test(name, async () => {
    const fixture = clientFixture({ items });
    await assert.rejects(readLastReply(fixture.client, sessionId, options), errorCode(code));
    assert.deepEqual(fixture.calls, expectedCalls);
  });
});

test('readLastReply returns blank sessions without downloading or paging', async t => {
  for (const supplied of [false, true]) await t.test(supplied ? 'supplied summary' : 'listed summary', async () => {
    const item = summary({ blank: true });
    const fixture = clientFixture({ items: [item] });
    const result = await readLastReply(fixture.client, sessionId, supplied ? { summary: item } : {});
    assert.deepEqual(result, {
      sessionId, title: 'Projected title', running: false, blank: true, lastInteractionAt: null,
      lastPrompt: null, lastResponse: null, lastFinalReply: null, lastTurnStatus: 'blank',
    });
    assert.deepEqual(fixture.calls, supplied ? [] : [{ method: 'session/list', args: { _request: {} } }]);
  });
});

test('readLastReply pages backwards by covered sequence ranges while preserving the exact cut', async () => {
  const pages = [
    { records: [
      { event: event('tool/result', 38), covers: { from: 30, to: 38 } },
      ...records(prompt(40, [image]), prompt(41, 'Injected', { kind: 'system' })),
    ], hasMore: true },
    { records: records(event('fixture/unknown', 20), response(23, ''), response(24, [image])), hasMore: true },
    { records: records(response(12, 'Earlier completed answer'), turnEnd(14)), hasMore: true },
  ];
  const fixture = clientFixture({ pages });
  const result = await readLastReply(fixture.client, sessionId, { throughSeq: 50, summary: summary(), maxMessages: 2 });
  assert.deepEqual(fixture.calls, [
    { method: 'session/page', args: pageArgs(50, { maxMessages: 2 }) },
    { method: 'session/page', args: pageArgs(50, { maxMessages: 2, beforeSeq: 30 }) },
    { method: 'session/page', args: pageArgs(50, { maxMessages: 2, beforeSeq: 20 }) },
  ]);
  assert.equal(result.lastFinalReply.text, 'Earlier completed answer');
  assert.deepEqual(result.lastPrompt, { seq: 40, time: 4000, text: '', hasAttachments: true });
  assert.equal(result.newerPromptWithoutResponse, true);
  assert.equal(result.throughSeq, 50);
});

test('readLastReply stops on an empty page or exhausted history without retrying', async t => {
  for (const [name, page] of [
    ['empty but has more', { records: [], hasMore: true }],
    ['exhausted without assistant text', { records: records(prompt(1, 'Question')), hasMore: false }],
  ]) await t.test(name, async () => {
    const fixture = clientFixture({ pages: [page] });
    const result = await readLastReply(fixture.client, sessionId, { throughSeq: 10, summary: summary() });
    assert.equal(result.lastResponse, null);
    assert.equal(result.lastFinalReply, null);
    assert.equal(fixture.calls.length, 1);
  });
});

test('readLastReply bounds pages when no assistant text is found', async () => {
  const fixture = clientFixture({ pages: [
    { records: records(prompt(30, 'Question')), hasMore: true },
    { records: records(event('tool/result', 20)), hasMore: true },
  ] });
  const result = await readLastReply(fixture.client, sessionId, { throughSeq: 50, summary: summary(), maxPages: 2 });
  assert.equal(result.lastResponse, null);
  assert.equal(result.lastPrompt.text, 'Question');
  assert.match(result.note, /bounded history search/u);
  assert.deepEqual(fixture.calls, [
    { method: 'session/page', args: pageArgs(50) },
    { method: 'session/page', args: pageArgs(50, { beforeSeq: 30 }) },
  ]);
});

test('readLastReply rejects repeated or forward-moving history cursors', async t => {
  for (const first of [30, 31]) await t.test(first === 30 ? 'repeated' : 'forward-moving', async () => {
    const fixture = clientFixture({ pages: [
      { records: records(event('tool/result', 30)), hasMore: true },
      { records: [{ event: event('tool/result', 40), covers: { from: first, to: 40 } }], hasMore: true },
    ] });
    await assert.rejects(readLastReply(fixture.client, sessionId, { throughSeq: 50, summary: summary() }), errorCode('BAD_PAGE'));
    assert.equal(fixture.calls.length, 2);
  });
});

test('readLastReply propagates export and page failures without falling back to session/follow', async () => {
  const download = downloadFixture([archive(jsonl([], { ...header, id: 'wrong' }))]);
  const badExport = clientFixture({ download });
  await assert.rejects(readLastReply(badExport.client, sessionId, { summary: summary() }), errorCode('BAD_EXPORT'));
  assert.deepEqual(badExport.calls, [{ method: 'download', path: exportPath() }]);
  const failure = new RpcError('FIXTURE_PAGE_FAILURE', 'Synthetic page failed');
  const badPage = clientFixture({ pages: [failure] });
  await assert.rejects(readLastReply(badPage.client, sessionId, { throughSeq: 4, summary: summary() }), error => error === failure);
  assert.deepEqual(badPage.calls, [{ method: 'session/page', args: pageArgs(4) }]);
});

test('describePage orders a same-millisecond prompt after the reply by sequence', () => {
  const result = describePage(records(
    prompt(1, 'Earlier question'), response(4, 'Earlier reply', 'turn-1', {}), turnEnd(5),
    event('user/message', 6, { content: [text('Follow-up')], source: { kind: 'user' } }, 400),
  ), { header, cursor: 6, lastPromptAt: 400, lastPromptSeq: 6 }, summary());
  assert.equal(result.lastResponse.time, 400);
  assert.equal(result.lastPrompt.time, 400);
  assert.equal(result.newerPromptWithoutResponse, true);
});

test('committed export metadata records the last human prompt sequence', () => {
  const result = decode(archive(jsonl([prompt(3, 'Question'), response(4, 'Reply'), prompt(7, 'Injected', { kind: 'system' })])));
  assert.equal(result.lastPromptSeq, 3);
});

test('readLastReply keeps paging past progress text to the previous completed reply', async () => {
  const pages = [
    { records: records(turnStart(20, 'turn-2'), response(22, 'Working on it', 'turn-2')), hasMore: true },
    { records: records(prompt(10, 'Question'), response(12, 'Completed answer'), turnEnd(14)), hasMore: true },
  ];
  const fixture = clientFixture({ pages });
  const result = await readLastReply(fixture.client, sessionId, { throughSeq: 22, summary: summary({ running: true }) });
  assert.equal(fixture.calls.length, 2);
  assert.equal(result.lastResponse.text, 'Working on it');
  assert.equal(result.lastResponse.kind, 'progress');
  assert.equal(result.lastFinalReply.text, 'Completed answer');
  assert.equal(result.note, undefined);
});

test('readLastReply reports a missing completed reply when only progress text is in range', async () => {
  const fixture = clientFixture({ pages: [
    { records: records(response(22, 'Working on it', 'turn-2')), hasMore: true },
    { records: records(response(12, 'Still working', 'turn-1')), hasMore: true },
  ] });
  const result = await readLastReply(fixture.client, sessionId, { throughSeq: 22, summary: summary(), maxPages: 2 });
  assert.equal(result.lastFinalReply, null);
  assert.match(result.note, /No completed reply/u);
});

const parentId = 'session-parent-fixture';
const childEntry = (overrides = {}) => ({ kind: 'child', id: sessionId, mode: 'continuable', label: 'Child label', activity: 'inactive', hasChildren: false, ...overrides });

test('readLastReply reads a subagent child through its parent address and exact export cursor', async () => {
  const events = [prompt(1, 'Child task'), turnStart(2), response(4, 'Child answer'), turnEnd(5)];
  const download = downloadFixture([archive(jsonl(events, { ...header, parentSession: parentId, origin: 'subagent' }))]);
  const fixture = clientFixture({ download, children: [childEntry({ activity: 'running' })],
    pages: [{ records: records(...events), hasMore: false }] });
  const result = await readLastReply(fixture.client, sessionId, { parentSessionId: parentId });
  assert.deepEqual(fixture.calls.map(call => call.method), ['subagents/list', 'download', 'session/page']);
  assert.deepEqual(fixture.calls[0].args, { parentSessionId: parentId });
  assert.deepEqual(fixture.calls[2].args.request.address,
    { kind: 'subagent', parentSessionId: parentId, childSessionId: sessionId, mode: 'continuable' });
  assert.equal(fixture.calls[2].args.request.throughSeq, 5);
  assert.equal(result.lastFinalReply.text, 'Child answer');
  assert.equal(result.running, true);
});

test('readLastReply refuses a child that is not listed under the named parent', async t => {
  for (const [name, children, log, code, methods] of [
    ['unlisted child', [childEntry({ id: 'other-child' })], undefined, 'NOT_FOUND', ['subagents/list']],
    ['export names another parent', [childEntry()], jsonl([], { ...header, parentSession: 'session-other-parent' }), 'BAD_EXPORT', ['subagents/list', 'download']],
  ]) await t.test(name, async () => {
    const fixture = clientFixture({ children, download: log && downloadFixture([archive(log)]) });
    await assert.rejects(readLastReply(fixture.client, sessionId, { parentSessionId: parentId }), errorCode(code));
    assert.deepEqual(fixture.calls.map(call => call.method), methods);
  });
});
