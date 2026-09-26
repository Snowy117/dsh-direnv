/**
 * Protocol-error path: the fake LLM never sends a `finish_reason`.
 *
 * This pins the failure signature so nobody debugs it as a hang again: pi-ai
 * throws "Stream ended without finish_reason", `llm-retry` retries the request
 * 5 times with backoff (~17s total) before the turn ends with a TRANSPORT error
 * and a non-zero exit. The run must contain ZERO tool results: the error happens
 * before any tool is dispatched.
 */
import type { HarnessCase } from '../cases.ts';

export default {
  name: 'no-finish-reason',
  description: 'Fake LLM omits finish_reason: expect 5 backoff retries (~17s), TRANSPORT error, non-zero exit, no tool execution.',
  gateMs: 0,
  timeoutMs: 180000,
  task: 'Use the bash tool to run: echo STUB-LLM-OK',
  files: {},
  fake: {
    omitFinishReason: true,
    toolCalls: [{ name: 'bash', arguments: { command: 'echo STUB-LLM-OK', description: 'harness bash call 1' } }],
  },
  expect: {
    exitCode: 'nonzero',
    noTimeout: true,
    finalText: { equals: '' },
    stderr: { contains: 'Stream ended without finish_reason' },
    stdout: { contains: 'turn_end' },
    toolResultCount: 0,
    toolResults: [],
    timelineHas: ['turn/end'],
    metrics: {
      toolCalls: 0,
      toolResults: 0,
      // 1 opening attempt + 5 llm-retry backoff attempts
      'fake.toolRouteAttempts': [5, 8],
      'fake.titleRoute': 1,
      'fake.closingRoute': 0,
      'fake.unhandled': 0,
      wallMs: [8000, 90000],
    },
  },
} satisfies HarnessCase;
