/**
 * Negative control: the gate is armed but holds nothing.
 *
 * Proves the pipeline itself is healthy before any blocking claim is made: one
 * real tool execution, exit 0, and sub-second gate timings. `gate-7000` is
 * meaningful only next to this baseline.
 */
import type { HarnessCase } from '../cases.ts';

export default {
  name: 'gate-0',
  description: 'Baseline: one bash call, probe gate armed with gateMs=0, expect exit 0 and a real tool result.',
  gateMs: 0,
  task: 'Use the bash tool to run: echo STUB-LLM-OK',
  files: {},
  fake: {
    toolCalls: [{ name: 'bash', arguments: { command: 'echo STUB-LLM-OK', description: 'harness bash call 1' } }],
  },
  expect: {
    exitCode: 0,
    noTimeout: true,
    finalText: { contains: 'FAKE-FINAL' },
    stderr: { notContains: ['TRANSPORT', 'did not activate'] },
    toolResultCount: 1,
    toolResults: [{ equals: 'STUB-LLM-OK\n', isError: false }],
    timelineHas: ['tool/call', 'tool/result', 'turn/end'],
    metrics: {
      toolCalls: 1,
      toolResults: 1,
      'call->gate/enter:call_fake_1': [0, 1500],
      'gate/enter->exit:call_fake_1': [0, 800],
      'call->result:call_fake_1': [0, 3000],
      'fake.requests': 3, // opening tool request + racing title request + closing text request
      'fake.titleRoute': 1,
      'fake.toolRouteAttempts': 1,
      'fake.closingRoute': 1,
      'fake.unhandled': 0,
      wallMs: [0, 60000],
    },
  },
} satisfies HarnessCase;
